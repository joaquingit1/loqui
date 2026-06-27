/**
 * @file Auto-register Loqui's local MCP server with Claude Code so a fresh
 * `claude` session can read the user's meetings WITHOUT any manual setup — the
 * way a hosted connector (e.g. Granola) just appears.
 *
 * Claude Code discovers MCP servers from its **user-scope** config at
 * `~/.claude.json` (`mcpServers.<name>`). Loqui's server is local, so nothing
 * registers it unless we do. We write a **stdio** entry whose command is Loqui's
 * OWN binary run as Node (`ELECTRON_RUN_AS_NODE=1`): that runs `loqui-mcp`
 * headlessly (no GUI) to read the meeting DB, works whether or not the app is
 * open, and loads the Electron-ABI `better-sqlite3` correctly (plain `node`
 * would crash with NODE_MODULE_VERSION — why the old stdio snippet never worked).
 *
 * The merge is conservative: it preserves every other key, only ever touches
 * `mcpServers.loqui`, skips the write when nothing changed (idempotent), writes
 * atomically (temp + rename), and ABORTS rather than clobber a file it can't
 * parse. Everything is best-effort — registration must never block app launch.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR_ENV, MCP_SERVER_NAME } from "@loqui/shared";

/** A Claude Code stdio `mcpServers` entry. */
export interface LoquiMcpStdioEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Build the stdio entry that runs the bundled `loqui-mcp` under Loqui's own
 * Electron binary as Node — so it works with the GUI quit and with the right
 * native-module ABI.
 */
export function buildLoquiMcpEntry(args: {
  execPath: string;
  binPath: string;
  dataRoot: string;
}): LoquiMcpStdioEntry {
  return {
    command: args.execPath,
    args: [args.binPath],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      [DATA_DIR_ENV]: args.dataRoot,
    },
  };
}

export type RegistrationResult = "added" | "updated" | "unchanged" | "skipped";

export interface EnsureRegistrationDeps {
  /** The entry to register under `mcpServers.loqui`. */
  entry: LoquiMcpStdioEntry;
  /** Path to Claude Code's user config. Defaults to `~/.claude.json`. */
  claudeJsonPath?: string;
  /** Read hook (tests inject). Default: `readFileSync(p, "utf8")`. */
  readFileFn?: (path: string) => string;
  /** Write hook (tests inject). Default: atomic temp-file + rename. */
  writeFileFn?: (path: string, data: string) => void;
  /** Diagnostic sink. */
  log?: (msg: string) => void;
}

/**
 * Ensure `mcpServers.loqui` in `~/.claude.json` equals {@link buildLoquiMcpEntry}.
 * Idempotent + non-destructive (see file header). Returns what it did.
 */
export function ensureClaudeCodeRegistration(deps: EnsureRegistrationDeps): RegistrationResult {
  const path = deps.claudeJsonPath ?? join(homedir(), ".claude.json");
  const log = deps.log ?? ((): void => {});
  const readFileFn = deps.readFileFn ?? ((p: string): string => readFileSync(p, "utf8"));
  const writeFileFn = deps.writeFileFn ?? defaultAtomicWrite;

  // Read the existing config (a missing file is fine → start from {}).
  let raw: string | null = null;
  try {
    raw = readFileFn(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") raw = null;
    else {
      log(`MCP register: cannot read ${path}: ${String(err)}`);
      return "skipped";
    }
  }

  let config: Record<string, unknown>;
  if (raw == null || raw.trim() === "") {
    config = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log(`MCP register: ${path} is not valid JSON — aborting (won't clobber): ${String(err)}`);
      return "skipped";
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      log(`MCP register: ${path} is not a JSON object — aborting (won't clobber)`);
      return "skipped";
    }
    config = parsed as Record<string, unknown>;
  }

  const existingServers = config.mcpServers;
  const servers: Record<string, unknown> =
    existingServers && typeof existingServers === "object" && !Array.isArray(existingServers)
      ? (existingServers as Record<string, unknown>)
      : {};

  const current = servers[MCP_SERVER_NAME];
  const isAdd = current === undefined;
  // Stable-key JSON compare is enough: we are the only writer of this entry, so a
  // prior write round-trips to the same key order.
  if (!isAdd && JSON.stringify(current) === JSON.stringify(deps.entry)) return "unchanged";

  servers[MCP_SERVER_NAME] = deps.entry;
  config.mcpServers = servers;

  try {
    writeFileFn(path, JSON.stringify(config, null, 2) + "\n");
  } catch (err) {
    log(`MCP register: failed to write ${path}: ${String(err)}`);
    return "skipped";
  }
  return isAdd ? "added" : "updated";
}

/** Atomic write: same-dir temp file + rename (a crash mid-write can't corrupt). */
function defaultAtomicWrite(path: string, data: string): void {
  const tmp = join(dirname(path), `.${MCP_SERVER_NAME}-claude-${process.pid}.tmp`);
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}
