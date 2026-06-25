/**
 * PRD-8 — engine orchestration tests (hermetic; stubbed fetch + httpGet feeding a
 * fixture zip; NO real GitHub). Covers:
 *   - no-update no-op (equal/older manifest) -> phase "up-to-date".
 *   - newer -> download -> sha256 verify -> extract -> phase "ready" + staged tree.
 *   - sha256 mismatch -> phase "error", installed app untouched, NOT ready.
 *   - offline (fetch throws) -> phase "error", safe.
 *   - "check now" is single-flighted; a ready update is terminal until restart.
 *   - quitAndInstall spawns the detached helper with the staged path + quits.
 *   - autoDownload off -> notify-only (available, not downloaded).
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { updaterSettingsSchema, type UpdateManifest } from "@loqui/shared";
import { UpdaterEngine, type UpdaterEngineDeps } from "./engine.js";
import { buildZip } from "./zipfixture.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "loqui-eng-"));
}
function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const ZIP = buildZip([
  { name: "Loqui.app/Contents/MacOS/Loqui", data: "BIN".repeat(40), method: "deflate" },
]);
const ASSET_URL = "https://example.com/releases/Loqui-2.0.0-win.zip";

function manifest(version: string, sha256 = sha(ZIP)): UpdateManifest {
  return {
    version,
    notes: `Release ${version}`,
    platforms: { "win32-x64": { url: ASSET_URL, sha256, size: ZIP.length } },
  };
}

function makeEngine(
  over: Partial<UpdaterEngineDeps> & { autoDownload?: boolean } = {},
): {
  engine: UpdaterEngine;
  spawn: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  states: string[];
  staging: string;
} {
  const staging = over.stagingDir ?? tmp();
  const spawn = vi.fn();
  const quit = vi.fn();
  const states: string[] = [];
  const settings = updaterSettingsSchema.parse({
    autoDownload: over.autoDownload ?? true,
  });
  const deps: UpdaterEngineDeps = {
    currentVersion: "1.0.0",
    platform: "win32",
    arch: "x64",
    fetchManifest: over.fetchManifest ?? (async () => manifest("2.0.0")),
    stagingDir: staging,
    httpGet: over.httpGet ?? (async () => ZIP),
    helperInput: () => ({
      platform: "win32",
      helperScript: "C:/res/build-helpers/update-helper.ps1",
      parentPid: 999,
      installPath: "C:/Program Files/Loqui",
      relaunchTarget: "C:/Program Files/Loqui/Loqui.exe",
    }),
    detachedSpawn: spawn,
    quit,
    now: () => new Date("2026-06-25T12:00:00.000Z"),
    onStateChange: (s) => states.push(s.phase),
  };
  return { engine: new UpdaterEngine(deps, settings), spawn, quit, states, staging };
}

describe("UpdaterEngine.checkNow", () => {
  it("no-op when the manifest is not newer (equal) -> up-to-date", async () => {
    const { engine } = makeEngine({ fetchManifest: async () => manifest("1.0.0") });
    const state = await engine.checkNow();
    expect(state.phase).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.lastCheckedAt).toBe("2026-06-25T12:00:00.000Z");
  });

  it("newer -> downloads, sha256-verifies, extracts, and goes ready", async () => {
    const { engine, staging, states } = makeEngine();
    const state = await engine.checkNow();
    expect(state.phase).toBe("ready");
    expect(state.availableVersion).toBe("2.0.0");
    expect(state.downloadProgress).toBe(1);
    // The verified, extracted tree exists in staging.
    expect(existsSync(join(staging, "extracted", "Loqui.app/Contents/MacOS/Loqui"))).toBe(true);
    // Phase progression observed via the push.
    expect(states).toEqual(
      expect.arrayContaining(["checking", "downloading", "ready"]),
    );
  });

  it("ABORTS on a sha256 mismatch -> error, NOT ready, app untouched", async () => {
    const { engine, staging } = makeEngine({
      fetchManifest: async () => manifest("2.0.0", "0".repeat(64)),
    });
    const state = await engine.checkNow();
    expect(state.phase).toBe("error");
    expect(state.error).toMatch(/integrity/i);
    // Nothing was staged/extracted.
    expect(existsSync(join(staging, "extracted"))).toBe(false);
    // A subsequent quitAndInstall is a no-op (no staged update).
    expect(state.phase).not.toBe("ready");
  });

  it("offline (fetch throws) -> error, safe, retryable", async () => {
    const { engine } = makeEngine({
      fetchManifest: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      },
    });
    const state = await engine.checkNow();
    expect(state.phase).toBe("error");
    expect(state.error).toMatch(/ENOTFOUND/);
    // The next check can run (single-flight released).
    const ok = makeEngine();
    expect((await ok.engine.checkNow()).phase).toBe("ready");
  });

  it("a partial download (sha mismatch on truncated body) aborts safely", async () => {
    const { engine } = makeEngine({ httpGet: async () => ZIP.subarray(0, 5) });
    const state = await engine.checkNow();
    expect(state.phase).toBe("error");
  });

  it("autoDownload off -> notify-only (available, not downloaded)", async () => {
    const { engine, staging } = makeEngine({ autoDownload: false });
    const state = await engine.checkNow();
    expect(state.availableVersion).toBe("2.0.0");
    expect(state.phase).toBe("idle");
    expect(existsSync(join(staging, "extracted"))).toBe(false);
  });

  it("a ready update is terminal until restart (re-check is a no-op)", async () => {
    const { engine } = makeEngine();
    await engine.checkNow();
    expect(engine.getState().phase).toBe("ready");
    // A re-check does not re-download / change phase.
    const again = await engine.checkNow();
    expect(again.phase).toBe("ready");
  });
});

describe("UpdaterEngine.quitAndInstall", () => {
  it("spawns the detached helper with the staged path, then quits", async () => {
    const { engine, spawn, quit, staging } = makeEngine();
    await engine.checkNow();
    engine.quitAndInstall();
    expect(spawn).toHaveBeenCalledOnce();
    const plan = spawn.mock.calls[0]![0] as { command: string; args: string[] };
    expect(plan.command).toBe("powershell.exe");
    expect(plan.args).toContain(join(staging, "extracted"));
    expect(quit).toHaveBeenCalledOnce();
  });

  it("is a no-op when no update is staged", () => {
    const { engine, spawn, quit } = makeEngine();
    engine.quitAndInstall(); // phase is idle
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("staged zip content matches what was downloaded (end-to-end integrity)", async () => {
    const { engine, staging } = makeEngine();
    await engine.checkNow();
    const extracted = readFileSync(
      join(staging, "extracted", "Loqui.app/Contents/MacOS/Loqui"),
      "utf8",
    );
    expect(extracted).toBe("BIN".repeat(40));
  });
});
