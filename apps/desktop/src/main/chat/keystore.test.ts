/**
 * Hermetic tests for the secure BYOK key + provider-settings store (PRD-4).
 *
 * Every test points LOQUI_DATA_DIR at a fresh os.tmpdir() subdir (paths.ts reads
 * the env var at call time) so the real ~/Loqui is NEVER touched. The Electron
 * `safeStorage` is replaced by an injected fake that round-trips encrypt/decrypt
 * with a recognizable prefix + base64 body, so we can assert the on-disk blob is
 * the CIPHERTEXT and never the plaintext key.
 *
 * Invariants asserted here:
 *   - the API key round-trips through safeStorage (encrypt -> base64 on disk ->
 *     decrypt), and the raw key NEVER appears in the settings file;
 *   - the key is NEVER logged (console spy);
 *   - getApiKeyStatus / setApiKey return only {provider, hasKey} — never the key;
 *   - provider settings persist as plain JSON and survive a fresh instance;
 *   - an empty/null key CLEARS the stored entry;
 *   - the keystore has NO transcript-write capability (structural assertion).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_ENV, DEFAULT_ANTHROPIC_CHAT_MODEL } from "@loqui/shared";
import { ChatKeystore, type SafeStorageLike } from "./keystore.js";

/**
 * A fake safeStorage: encryption is reversible but the ciphertext is clearly NOT
 * the plaintext (prefix + reversed bytes) so a substring scan of the file proves
 * the key never landed in cleartext. `available` is togglable to exercise the
 * unavailable-OS path.
 */
const ENC_PREFIX = "enc:";

function makeFakeSafeStorage(available = true): SafeStorageLike & {
  available: boolean;
  encryptCalls: string[];
} {
  const state = {
    available,
    encryptCalls: [] as string[],
    isEncryptionAvailable() {
      return state.available;
    },
    encryptString(plainText: string): Buffer {
      state.encryptCalls.push(plainText);
      // Reversible, but visibly not the plaintext: prefix + reversed chars.
      const scrambled = ENC_PREFIX + [...plainText].reverse().join("");
      return Buffer.from(scrambled, "utf8");
    },
    decryptString(encrypted: Buffer): string {
      const s = encrypted.toString("utf8");
      if (!s.startsWith(ENC_PREFIX)) throw new Error("bad ciphertext");
      return [...s.slice(ENC_PREFIX.length)].reverse().join("");
    },
  };
  return state;
}

const SECRET = "sk-ant-SUPERSECRET-0123456789";
let tmp: string;

function settingsPath(): string {
  return join(tmp, "chat-settings.json");
}

function readSettingsRaw(): string {
  return existsSync(settingsPath()) ? readFileSync(settingsPath(), "utf8") : "";
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loqui-keystore-"));
  process.env[DATA_DIR_ENV] = tmp;
});

afterEach(() => {
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("provider settings", () => {
  it("returns defaulted settings when nothing is persisted", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    const cfg = ks.getProviderSettings();
    expect(cfg.provider).toBe("fake");
    expect(cfg.model).toBe(DEFAULT_ANTHROPIC_CHAT_MODEL);
    expect(cfg.baseUrl).toBe("http://localhost:11434");
  });

  it("persists provider settings as plain JSON and survives a fresh instance", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    const saved = ks.setProviderSettings({
      provider: "ollama",
      model: "claude-opus-4-8",
      baseUrl: "http://localhost:11434",
      ollamaModel: "llama3.1",
      cli: "claude",
      nativeModel: "",
      summaryTemplate: "",
    });
    expect(saved.provider).toBe("ollama");

    // A brand-new instance reads the same persisted value.
    const ks2 = new ChatKeystore(makeFakeSafeStorage());
    expect(ks2.getProviderSettings().provider).toBe("ollama");

    const raw = readSettingsRaw();
    expect(raw).toContain("providerConfig");
    expect(raw).toContain("ollama");
  });

  it("validates + defaults malformed persisted settings", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    // Persisting a partial config fills defaults.
    const saved = ks.setProviderSettings({ provider: "anthropic" } as never);
    expect(saved.provider).toBe("anthropic");
    expect(saved.model).toBe(DEFAULT_ANTHROPIC_CHAT_MODEL);
  });
});

describe("API key storage (safeStorage)", () => {
  it("round-trips the key encrypted: ciphertext on disk, plaintext never present", () => {
    const safe = makeFakeSafeStorage();
    const ks = new ChatKeystore(safe);

    const status = ks.setApiKey({ provider: "anthropic", apiKey: SECRET });
    expect(status).toEqual({ provider: "anthropic", hasKey: true });

    // It was encrypted via safeStorage.
    expect(safe.encryptCalls).toContain(SECRET);

    // The on-disk file contains the CIPHERTEXT (base64), never the raw key.
    const raw = readSettingsRaw();
    expect(raw).not.toContain(SECRET);
    // base64 of the scrambled ciphertext is what is stored.
    const expectedB64 = safe.encryptString(SECRET).toString("base64");
    expect(raw).toContain(expectedB64);

    // It decrypts back to the original for the transient forward.
    expect(ks.getApiKey("anthropic")).toBe(SECRET);
  });

  it("getApiKeyStatus reports presence but NEVER returns the key", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    expect(ks.getApiKeyStatus("anthropic")).toEqual({
      provider: "anthropic",
      hasKey: false,
    });
    ks.setApiKey({ provider: "anthropic", apiKey: SECRET });
    const status = ks.getApiKeyStatus("anthropic");
    expect(status).toEqual({ provider: "anthropic", hasKey: true });
    // No field carries the key.
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it("never logs the key (set, get, decrypt)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    const ks = new ChatKeystore(makeFakeSafeStorage());
    ks.setApiKey({ provider: "anthropic", apiKey: SECRET });
    ks.getApiKeyStatus("anthropic");
    ks.getApiKey("anthropic");

    for (const spy of [log, err, warn, info, debug]) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => String(a)).join(" ");
        expect(joined).not.toContain(SECRET);
      }
    }
  });

  it("clears the stored key on an empty string", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    ks.setApiKey({ provider: "anthropic", apiKey: SECRET });
    expect(ks.getApiKeyStatus("anthropic").hasKey).toBe(true);

    const status = ks.setApiKey({ provider: "anthropic", apiKey: "" });
    expect(status).toEqual({ provider: "anthropic", hasKey: false });
    expect(ks.getApiKey("anthropic")).toBeNull();
    // The ciphertext is gone from disk.
    expect(readSettingsRaw()).not.toContain("enc:");
  });

  it("clears the stored key on a null/whitespace key", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    ks.setApiKey({ provider: "anthropic", apiKey: SECRET });
    const status = ks.setApiKey({ provider: "anthropic", apiKey: null });
    expect(status.hasKey).toBe(false);
    expect(ks.getApiKey("anthropic")).toBeNull();
  });

  it("preserves provider settings when a key is stored, and vice versa", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    ks.setProviderSettings({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: "http://localhost:11434",
      ollamaModel: "llama3.1",
      cli: "claude",
      nativeModel: "",
      summaryTemplate: "",
    });
    ks.setApiKey({ provider: "anthropic", apiKey: SECRET });
    // Settings survive the key write.
    expect(ks.getProviderSettings().model).toBe("claude-sonnet-4-6");
    // And the key survives a settings write.
    ks.setProviderSettings({
      provider: "ollama",
      model: "claude-opus-4-8",
      baseUrl: "http://localhost:11434",
      ollamaModel: "llama3.1",
      cli: "claude",
      nativeModel: "",
      summaryTemplate: "",
    });
    expect(ks.getApiKey("anthropic")).toBe(SECRET);
  });

  it("throws when encryption is unavailable on this OS", () => {
    const safe = makeFakeSafeStorage(false);
    const ks = new ChatKeystore(safe);
    expect(() => ks.setApiKey({ provider: "anthropic", apiKey: SECRET })).toThrow(
      /not available/i,
    );
    // Nothing was persisted.
    expect(readSettingsRaw()).not.toContain("enc:");
  });

  it("refuses to store a key under the Linux 'basic_text' obfuscation backend", () => {
    const safe = makeFakeSafeStorage(true) as ReturnType<typeof makeFakeSafeStorage> & {
      getSelectedStorageBackend(): string;
    };
    safe.getSelectedStorageBackend = () => "basic_text";
    const ks = new ChatKeystore(safe);
    expect(() => ks.setApiKey({ provider: "anthropic", apiKey: SECRET })).toThrow(
      /basic_text|plaintext/i,
    );
    // Nothing was persisted and the key was never encrypted/written.
    expect(readSettingsRaw()).not.toContain("enc:");
    expect(safe.encryptCalls).not.toContain(SECRET);
  });

  it("stores normally under a real backend (gnome_libsecret / unspecified)", () => {
    const safe = makeFakeSafeStorage(true) as ReturnType<typeof makeFakeSafeStorage> & {
      getSelectedStorageBackend(): string;
    };
    safe.getSelectedStorageBackend = () => "gnome_libsecret";
    const ks = new ChatKeystore(safe);
    expect(ks.setApiKey({ provider: "anthropic", apiKey: SECRET }).hasKey).toBe(true);
    expect(ks.getApiKey("anthropic")).toBe(SECRET);
  });

  it("getApiKey returns null when encryption is unavailable at read time", () => {
    const safe = makeFakeSafeStorage(true);
    const ks = new ChatKeystore(safe);
    ks.setApiKey({ provider: "anthropic", apiKey: SECRET });
    // OS keychain becomes unavailable later (e.g. locked) -> no decrypt, no throw.
    safe.available = false;
    expect(ks.getApiKey("anthropic")).toBeNull();
  });

  it("returns null for a provider with no stored key", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    expect(ks.getApiKey("anthropic")).toBeNull();
    expect(ks.getApiKey("ollama")).toBeNull();
  });

  it("tolerates a corrupt settings file by starting fresh", () => {
    // Pre-seed a garbage file.
    const ks0 = new ChatKeystore(makeFakeSafeStorage());
    ks0.setApiKey({ provider: "anthropic", apiKey: SECRET });
    // Corrupt it.
    rmSync(settingsPath(), { force: true });
    writeFileSync(settingsPath(), "{ not json", "utf8");

    const ks = new ChatKeystore(makeFakeSafeStorage());
    expect(ks.getProviderSettings().provider).toBe("fake"); // defaults
    expect(ks.getApiKeyStatus("anthropic").hasKey).toBe(false);
  });
});

describe("structural: no transcript-write capability", () => {
  it("exposes no write/append/patch method and never imports a TranscriptWriter", () => {
    const ks = new ChatKeystore(makeFakeSafeStorage());
    const names = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(ks)),
      ...Object.getOwnPropertyNames(ks),
    ];
    for (const name of names) {
      expect(name).not.toMatch(/transcript|writeTranscript|append|patch|meta/i);
    }
    // The source must not import the transcript writer or any store-write
    // surface. (It legitimately imports `dataRoot` from ../store/paths.js, a
    // read-only path resolver — that is NOT a write surface, so we assert on
    // the writer/controller modules and store-write method names instead.)
    const src = readFileSync(join(__dirname, "keystore.ts"), "utf8");
    expect(src).not.toMatch(/TranscriptWriter|transcript\/writer|transcript\/controller/);
    expect(src).not.toMatch(/from ["']\.\.\/store\/index/);
    expect(src).not.toMatch(/openStore|createTranscriptWriter|appendSegment/);
  });
});
