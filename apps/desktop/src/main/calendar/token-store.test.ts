/**
 * Hermetic tests for the calendar OAuth token store (PRD-15).
 *
 * LOQUI_DATA_DIR points at a fresh tmp dir so the real ~/Loqui is never touched.
 * Electron `safeStorage` is a fake that round-trips encrypt/decrypt with a
 * recognizable prefix, so we assert the on-disk blob is CIPHERTEXT and the
 * refresh token never lands in cleartext. Covers store/get/clear, the
 * connections listing (no tokens), lastSync stamping, and the Linux basic_text
 * refusal — exactly the PRD-4/5 keystore mechanism, separate file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_ENV } from "@loqui/shared";
import { CalendarKeystore } from "./token-store.js";
import type { CalendarOAuthTokens, SafeStorageLike } from "./types.js";

const ENC_PREFIX = "enc:";

function makeFakeSafeStorage(
  available = true,
  backend?: string,
): SafeStorageLike & { available: boolean } {
  const state = {
    available,
    isEncryptionAvailable() {
      return state.available;
    },
    encryptString(plainText: string): Buffer {
      return Buffer.from(ENC_PREFIX + [...plainText].reverse().join(""), "utf8");
    },
    decryptString(encrypted: Buffer): string {
      const s = encrypted.toString("utf8");
      if (!s.startsWith(ENC_PREFIX)) throw new Error("bad ciphertext");
      return [...s.slice(ENC_PREFIX.length)].reverse().join("");
    },
    getSelectedStorageBackend(): string {
      return backend ?? "keychain";
    },
  };
  return state;
}

const SECRET_REFRESH = "1//REFRESH-SUPER-SECRET-TOKEN";
const TOKENS: CalendarOAuthTokens = {
  accessToken: "ya29.ACCESS",
  refreshToken: SECRET_REFRESH,
  expiresAt: "2026-06-24T10:00:00.000Z",
  scope: "calendar.events.readonly",
};

let tmp: string;
function tokensPath(): string {
  return join(tmp, "calendar-tokens.json");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loqui-cal-tokens-"));
  process.env[DATA_DIR_ENV] = tmp;
});
afterEach(() => {
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

describe("CalendarKeystore", () => {
  it("round-trips tokens through safeStorage; the refresh token never lands plaintext", () => {
    const ks = new CalendarKeystore(makeFakeSafeStorage());
    ks.setTokens("google", "me@gmail.com", TOKENS);
    const got = ks.getTokens("google", "me@gmail.com");
    expect(got).toEqual(TOKENS);
    const onDisk = readFileSync(tokensPath(), "utf8");
    expect(onDisk).not.toContain(SECRET_REFRESH);
    expect(onDisk).not.toContain("ya29.ACCESS");
  });

  it("getConnections lists accounts (provider/account/lastSyncAt) without tokens", () => {
    const ks = new CalendarKeystore(makeFakeSafeStorage());
    ks.setTokens("google", "a@gmail.com", TOKENS);
    ks.setTokens("zoom", "b@zoom.com", TOKENS);
    const conns = ks.getConnections();
    expect(conns).toHaveLength(2);
    expect(conns.find((c) => c.provider === "google")?.account).toBe("a@gmail.com");
    expect(conns.every((c) => c.lastSyncAt === null)).toBe(true);
    expect(JSON.stringify(conns)).not.toContain(SECRET_REFRESH);
  });

  it("recordSync stamps lastSyncAt for a known account only", () => {
    const ks = new CalendarKeystore(makeFakeSafeStorage());
    ks.setTokens("google", "me@gmail.com", TOKENS);
    ks.recordSync("google", "me@gmail.com", "2026-06-24T09:30:00.000Z");
    expect(ks.getConnections()[0]?.lastSyncAt).toBe("2026-06-24T09:30:00.000Z");
    // Unknown account: no-op (does not create an entry).
    ks.recordSync("zoom", "ghost@zoom.com", "2026-06-24T09:30:00.000Z");
    expect(ks.getConnections()).toHaveLength(1);
  });

  it("clearTokens removes one account; preserves the rest", () => {
    const ks = new CalendarKeystore(makeFakeSafeStorage());
    ks.setTokens("google", "a@gmail.com", TOKENS);
    ks.setTokens("google", "b@gmail.com", TOKENS);
    ks.clearTokens("google", "a@gmail.com");
    expect(ks.getTokens("google", "a@gmail.com")).toBeNull();
    expect(ks.getTokens("google", "b@gmail.com")).not.toBeNull();
  });

  it("clearTokens with no account clears every account of the provider", () => {
    const ks = new CalendarKeystore(makeFakeSafeStorage());
    ks.setTokens("google", "a@gmail.com", TOKENS);
    ks.setTokens("google", "b@gmail.com", TOKENS);
    ks.setTokens("zoom", "z@zoom.com", TOKENS);
    ks.clearTokens("google");
    expect(ks.getConnections().map((c) => c.provider)).toEqual(["zoom"]);
  });

  it("refuses the Linux basic_text backend", () => {
    const ks = new CalendarKeystore(makeFakeSafeStorage(true, "basic_text"));
    expect(() => ks.setTokens("google", "me@gmail.com", TOKENS)).toThrow(/basic_text/);
    expect(existsSync(tokensPath())).toBe(false);
  });

  it("getTokens returns null when encryption is unavailable", () => {
    const fake = makeFakeSafeStorage(true);
    const ks = new CalendarKeystore(fake);
    ks.setTokens("google", "me@gmail.com", TOKENS);
    fake.available = false;
    expect(ks.getTokens("google", "me@gmail.com")).toBeNull();
  });

  it("a read with NO persisted tokens NEVER touches safeStorage (no keychain prompt)", () => {
    // First-open hygiene: a user who never connected a calendar must not trigger
    // the OS "Loqui wants to access safe storage" prompt. The constructor +
    // getConnections + a no-blob getTokens must not call ANY safeStorage method.
    const safe = makeFakeSafeStorage();
    const isAvail = vi.spyOn(safe, "isEncryptionAvailable");
    const decrypt = vi.spyOn(safe, "decryptString");

    const ks = new CalendarKeystore(safe);
    expect(ks.getConnections()).toEqual([]);
    expect(ks.getTokens("google", "me@gmail.com")).toBeNull();

    expect(isAvail).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
});
