/**
 * Hermetic tests for the HF-token keystore (PRD-5).
 *
 * Uses a temp LOQUI_DATA_DIR + a fake safeStorage (round-trip encrypt/decrypt
 * with availability + backend toggling) — no real OS keychain, no network. The
 * token never lands plaintext on disk and is never returned by the status API.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafeStorageLike } from "./hf-keystore.js";
import { HfKeystore } from "./hf-keystore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loqui-hf-"));
  process.env.LOQUI_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.LOQUI_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** A fake safeStorage: reversible "encryption" (prefix tag) for round-trip tests. */
function makeSafeStorage(
  opts: { available?: boolean; backend?: string } = {},
): SafeStorageLike {
  const available = opts.available ?? true;
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf: Buffer) => buf.toString("utf8").replace(/^enc:/, ""),
    getSelectedStorageBackend: opts.backend ? () => opts.backend! : undefined,
  };
}

const SETTINGS = "postprocess-settings.json";

describe("HfKeystore", () => {
  it("stores a token encrypted (never plaintext on disk) and reports hasToken", () => {
    const ks = new HfKeystore(makeSafeStorage());
    const status = ks.setHfToken({ token: "hf_SECRET_TOKEN" });
    expect(status).toEqual({ hasToken: true });

    const onDisk = readFileSync(join(dir, SETTINGS), "utf8");
    // The plaintext token must NOT appear; the ciphertext (base64 of "enc:...") does.
    expect(onDisk).not.toContain("hf_SECRET_TOKEN");
    const parsed = JSON.parse(onDisk) as { hfToken: string };
    expect(typeof parsed.hfToken).toBe("string");
    expect(Buffer.from(parsed.hfToken, "base64").toString("utf8")).toBe("enc:hf_SECRET_TOKEN");
  });

  it("round-trips the decrypted token via getHfToken", () => {
    const ks = new HfKeystore(makeSafeStorage());
    ks.setHfToken({ token: "hf_ROUND_TRIP" });
    expect(ks.getHfToken()).toBe("hf_ROUND_TRIP");
  });

  it("getHfToken is null when no token is stored", () => {
    const ks = new HfKeystore(makeSafeStorage());
    expect(ks.getHfToken()).toBeNull();
    expect(ks.getHfTokenStatus()).toEqual({ hasToken: false });
  });

  it("clears the token on an empty/null token", () => {
    const ks = new HfKeystore(makeSafeStorage());
    ks.setHfToken({ token: "hf_X" });
    expect(ks.getHfTokenStatus()).toEqual({ hasToken: true });
    expect(ks.setHfToken({ token: "" })).toEqual({ hasToken: false });
    expect(ks.getHfToken()).toBeNull();
    expect(ks.setHfToken({ token: "hf_Y" }).hasToken).toBe(true);
    expect(ks.setHfToken({ token: null }).hasToken).toBe(false);
  });

  it("the status surface never returns the token itself", () => {
    const ks = new HfKeystore(makeSafeStorage());
    const status = ks.setHfToken({ token: "hf_DO_NOT_LEAK" });
    expect(JSON.stringify(status)).not.toContain("hf_DO_NOT_LEAK");
    expect(JSON.stringify(ks.getHfTokenStatus())).not.toContain("hf_DO_NOT_LEAK");
  });

  it("defaults the diarization backend preference to auto", () => {
    const ks = new HfKeystore(makeSafeStorage());
    expect(ks.getDiarizationBackend()).toBe("auto");
    expect(ks.getDiarizationBackendStatus()).toEqual({ diarizationBackend: "auto" });
  });

  it("persists the diarization backend preference next to the encrypted token", () => {
    const ks = new HfKeystore(makeSafeStorage());
    expect(ks.setDiarizationBackend({ diarizationBackend: "sherpa" })).toEqual({
      diarizationBackend: "sherpa",
    });
    expect(ks.getDiarizationBackend()).toBe("sherpa");

    const onDisk = readFileSync(join(dir, SETTINGS), "utf8");
    const parsed = JSON.parse(onDisk) as { diarizationBackend: string };
    expect(parsed.diarizationBackend).toBe("sherpa");
  });

  it("throws when encryption is unavailable (does not write plaintext)", () => {
    const ks = new HfKeystore(makeSafeStorage({ available: false }));
    expect(() => ks.setHfToken({ token: "hf_X" })).toThrow(/not available/);
  });

  it("refuses the insecure linux 'basic_text' backend", () => {
    const ks = new HfKeystore(makeSafeStorage({ backend: "basic_text" }));
    expect(() => ks.setHfToken({ token: "hf_X" })).toThrow(/basic_text/);
  });

  it("getHfToken returns null if encryption became unavailable after storing", () => {
    // Store with an available backend, then read with an unavailable one.
    new HfKeystore(makeSafeStorage()).setHfToken({ token: "hf_X" });
    const reader = new HfKeystore(makeSafeStorage({ available: false }));
    expect(reader.getHfToken()).toBeNull();
  });
});
