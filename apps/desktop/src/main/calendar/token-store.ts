/**
 * PRD-15 — secure per-account OAuth token storage for the calendar feature.
 *
 * Import as: `import { CalendarKeystore } from "../calendar/token-store.js"`
 *
 * REUSES the EXACT PRD-4/5 safeStorage mechanism (the {@link SafeStorageLike}
 * surface + the Linux `basic_text` refusal) but writes to its OWN file so it
 * does not touch the chat keystore (PRD-4) or the postprocess HF token (PRD-5).
 * One keychain abstraction, three independent on-disk files.
 *
 * Each connected account's OAuth tokens (access + refresh + expiry) are
 * encrypted with Electron `safeStorage` (OS keychain-backed — Keychain on
 * macOS, DPAPI on Windows) and persisted as an opaque base64 blob — NEVER
 * plaintext on disk, NEVER logged, and NEVER returned to the renderer. The
 * non-secret connection metadata (provider/account/lastSyncAt) persists as
 * plain JSON alongside it so `getConnections` can list accounts without
 * decrypting any token.
 *
 * Files (under the resolved data root, honoring LOQUI_DATA_DIR so tests stay
 * hermetic):
 *   <dataRoot>/calendar-tokens.json — { accounts: { "<provider>:<account>":
 *                                       { tokens: <b64 ciphertext>, lastSyncAt } } }
 *
 * This module is the ONLY place that touches calendar token material. There is
 * NO transcript surface here — it constructs only calendar-tokens.json (never a
 * meeting transcript/meta path), so it structurally cannot read or write a
 * transcript/meta file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  calendarConnectionSchema,
  type CalendarConnection,
  type CalendarProviderId,
} from "@loqui/shared";
import { dataRoot } from "../store/paths.js";
import type { CalendarOAuthTokens, CalendarTokenStore, SafeStorageLike } from "./types.js";

/** On-disk shape of `calendar-tokens.json`. `tokens` is base64 ciphertext. */
interface CalendarAccountEntry {
  /** base64(ciphertext) of the JSON-serialized {@link CalendarOAuthTokens}. */
  tokens: string;
  /** ISO-8601 of the most recent successful sync, or null/absent if never. */
  lastSyncAt?: string | null;
}
interface CalendarTokensFile {
  accounts?: Record<string, CalendarAccountEntry>;
}

const CALENDAR_TOKENS_FILE = "calendar-tokens.json";

function calendarTokensPath(): string {
  return join(dataRoot(), CALENDAR_TOKENS_FILE);
}

/** Composite key for an (provider, account) entry. `:` cannot appear in a provider id. */
function accountKey(provider: CalendarProviderId, account: string): string {
  return `${provider}:${account}`;
}

/**
 * Secure {@link CalendarTokenStore} backed by the safeStorage keystore. Keyed by
 * (provider, account). Tokens are encrypted at rest; the connection metadata is
 * plain JSON. Refuses the Linux `basic_text` fallback (would land tokens
 * effectively plaintext), exactly like the PRD-4/5 keystores.
 */
export class CalendarKeystore implements CalendarTokenStore {
  readonly #safeStorage: SafeStorageLike;

  constructor(safeStorage: SafeStorageLike) {
    this.#safeStorage = safeStorage;
  }

  setTokens(
    provider: CalendarProviderId,
    account: string,
    tokens: CalendarOAuthTokens,
  ): void {
    if (!this.#safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage encryption is not available on this system");
    }
    // Refuse the Linux `basic_text` fallback: it reports available but is mere
    // obfuscation, so the refresh token would be effectively recoverable on
    // disk. (macOS Keychain / Windows DPAPI return their own backend names — or
    // none — and pass this guard.)
    const backend = this.#safeStorage.getSelectedStorageBackend?.();
    if (backend === "basic_text") {
      throw new Error(
        "safeStorage is using the insecure 'basic_text' backend; refusing to store calendar OAuth tokens in plaintext. Install/unlock a system keyring (e.g. gnome-keyring or kwallet) and retry.",
      );
    }
    const file = this.#readFile();
    const accounts = file.accounts ?? {};
    const key = accountKey(provider, account);
    const ciphertext = this.#safeStorage
      .encryptString(JSON.stringify(tokens))
      .toString("base64");
    accounts[key] = {
      tokens: ciphertext,
      // Preserve an existing lastSyncAt across a token refresh re-write.
      lastSyncAt: accounts[key]?.lastSyncAt ?? null,
    };
    file.accounts = accounts;
    this.#writeFile(file);
  }

  getTokens(provider: CalendarProviderId, account: string): CalendarOAuthTokens | null {
    const file = this.#readFile();
    const entry = file.accounts?.[accountKey(provider, account)];
    if (!entry?.tokens) return null;
    if (!this.#safeStorage.isEncryptionAvailable()) return null;
    try {
      const json = this.#safeStorage.decryptString(Buffer.from(entry.tokens, "base64"));
      const parsed = JSON.parse(json) as CalendarOAuthTokens;
      if (typeof parsed?.accessToken !== "string") return null;
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken ?? null,
        expiresAt: parsed.expiresAt ?? null,
        scope: parsed.scope ?? null,
      };
    } catch {
      return null;
    }
  }

  clearTokens(provider: CalendarProviderId, account?: string): void {
    const file = this.#readFile();
    const accounts = file.accounts ?? {};
    if (account !== undefined) {
      delete accounts[accountKey(provider, account)];
    } else {
      // Clear every account belonging to this provider.
      const prefix = `${provider}:`;
      for (const key of Object.keys(accounts)) {
        if (key.startsWith(prefix)) delete accounts[key];
      }
    }
    file.accounts = accounts;
    this.#writeFile(file);
  }

  getConnections(): CalendarConnection[] {
    const file = this.#readFile();
    const accounts = file.accounts ?? {};
    const out: CalendarConnection[] = [];
    for (const key of Object.keys(accounts)) {
      const sep = key.indexOf(":");
      if (sep <= 0) continue;
      const provider = key.slice(0, sep);
      const account = key.slice(sep + 1);
      const parsed = calendarConnectionSchema.safeParse({
        provider,
        account,
        lastSyncAt: accounts[key]?.lastSyncAt ?? null,
      });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  recordSync(provider: CalendarProviderId, account: string, at: string): void {
    const file = this.#readFile();
    const accounts = file.accounts ?? {};
    const key = accountKey(provider, account);
    const entry = accounts[key];
    if (!entry) return; // never seen this account: nothing to stamp.
    entry.lastSyncAt = at;
    file.accounts = accounts;
    this.#writeFile(file);
  }

  #readFile(): CalendarTokensFile {
    try {
      const raw = readFileSync(calendarTokensPath(), "utf8");
      const parsed = JSON.parse(raw) as CalendarTokensFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      // Corrupt file: start fresh rather than crash the calendar surface.
      return {};
    }
  }

  #writeFile(file: CalendarTokensFile): void {
    mkdirSync(dataRoot(), { recursive: true });
    writeFileSync(calendarTokensPath(), JSON.stringify(file, null, 2), "utf8");
  }
}
