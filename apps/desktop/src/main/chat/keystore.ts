/**
 * Secure BYOK API-key storage + provider settings (PRD-4).
 *
 * Import as: `import { ChatKeystore } from "../chat/keystore.js"`
 *
 * The API key is encrypted with Electron `safeStorage` (OS keychain-backed:
 * Keychain on macOS, DPAPI on Windows) and persisted as an opaque base64 blob —
 * NEVER plaintext on disk, and NEVER logged. The non-secret provider settings
 * (provider/model/baseUrl/cli) persist as plain JSON alongside it.
 *
 * Files (under the resolved data root, honoring LOQUI_DATA_DIR so tests stay
 * hermetic):
 *   <dataRoot>/chat-settings.json          — { providerConfig, keys: {<provider>: <b64 ciphertext>} }
 *
 * This module is the ONLY place that touches the key material. main reads the
 * decrypted key here and forwards it transiently to the sidecar on each chat
 * request; the renderer never sees it. There is no transcript surface here — the
 * keystore cannot read or write a transcript/meta file.
 *
 * `safeStorage` is injectable so unit tests can supply a fake (round-trip
 * encrypt/decrypt with availability toggling) without a real OS keychain.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiKeyStatusSchema,
  providerConfigSchema,
  type ApiKeyStatus,
  type ChatProvider,
  type ProviderConfig,
  type SetApiKeyParams,
} from "@loqui/shared";
import { dataRoot } from "../store/paths.js";

/** The subset of Electron `safeStorage` this module needs (injectable for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /**
   * Linux only: which OS backend safeStorage chose. When the Secret
   * Service/kwallet is unavailable, Electron falls back to `basic_text`, which
   * is hardcoded-key obfuscation (NOT real encryption) yet still reports
   * `isEncryptionAvailable() === true` — so a key would land effectively
   * plaintext on disk. We refuse that backend. Optional/absent on macOS
   * (Keychain) and Windows (DPAPI), where it is irrelevant.
   */
  getSelectedStorageBackend?(): string;
}

/** On-disk shape of `chat-settings.json`. `keys` values are base64 ciphertext. */
interface ChatSettingsFile {
  providerConfig?: unknown;
  keys?: Record<string, string>;
}

const CHAT_SETTINGS_FILE = "chat-settings.json";

function chatSettingsPath(): string {
  return join(dataRoot(), CHAT_SETTINGS_FILE);
}

export class ChatKeystore {
  readonly #safeStorage: SafeStorageLike;

  constructor(safeStorage: SafeStorageLike) {
    this.#safeStorage = safeStorage;
  }

  /** Read the persisted provider settings (defaults applied). */
  getProviderSettings(): ProviderConfig {
    const file = this.#readFile();
    return providerConfigSchema.parse(file.providerConfig ?? {});
  }

  /** Persist the provider settings (validated + defaulted); returns the stored value. */
  setProviderSettings(config: ProviderConfig): ProviderConfig {
    const clean = providerConfigSchema.parse(config ?? {});
    const file = this.#readFile();
    file.providerConfig = clean;
    this.#writeFile(file);
    return clean;
  }

  /**
   * Store (or clear, on an empty/null key) a provider's BYOK key, encrypted via
   * safeStorage. Returns only whether a key is now stored — NEVER the key.
   * Throws if encryption is unavailable on this OS (caller surfaces an error).
   */
  setApiKey(params: SetApiKeyParams): ApiKeyStatus {
    const provider = params.provider;
    const file = this.#readFile();
    const keys = file.keys ?? {};
    const raw = params.apiKey ?? "";
    if (raw.trim() === "") {
      // Clear.
      delete keys[provider];
      file.keys = keys;
      this.#writeFile(file);
      return apiKeyStatusSchema.parse({ provider, hasKey: false });
    }
    if (!this.#safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage encryption is not available on this system");
    }
    // Refuse the Linux `basic_text` fallback: it reports available but is mere
    // obfuscation, so the key would be effectively recoverable on disk. Never
    // persist a key under it. (macOS Keychain / Windows DPAPI return their own
    // backend names — or none — and pass this guard.)
    const backend = this.#safeStorage.getSelectedStorageBackend?.();
    if (backend === "basic_text") {
      throw new Error(
        "safeStorage is using the insecure 'basic_text' backend; refusing to store the API key in plaintext. Install/unlock a system keyring (e.g. gnome-keyring or kwallet) and retry.",
      );
    }
    keys[provider] = this.#safeStorage.encryptString(raw).toString("base64");
    file.keys = keys;
    this.#writeFile(file);
    return apiKeyStatusSchema.parse({ provider, hasKey: true });
  }

  /** Whether a BYOK key is currently stored for a provider (never returns the key). */
  getApiKeyStatus(provider: ChatProvider): ApiKeyStatus {
    const file = this.#readFile();
    const hasKey = Boolean(file.keys?.[provider]);
    return apiKeyStatusSchema.parse({ provider, hasKey });
  }

  /**
   * Decrypt + return the stored BYOK key for a provider, or null if none stored
   * (or decryption fails). main calls this to inject the transient key into a
   * chat request; the value is never logged or returned to the renderer.
   */
  getApiKey(provider: ChatProvider): string | null {
    const file = this.#readFile();
    const b64 = file.keys?.[provider];
    if (!b64) return null;
    if (!this.#safeStorage.isEncryptionAvailable()) return null;
    try {
      return this.#safeStorage.decryptString(Buffer.from(b64, "base64"));
    } catch {
      return null;
    }
  }

  #readFile(): ChatSettingsFile {
    try {
      const raw = readFileSync(chatSettingsPath(), "utf8");
      const parsed = JSON.parse(raw) as ChatSettingsFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      // Corrupt file: start fresh rather than crash the chat surface.
      return {};
    }
  }

  #writeFile(file: ChatSettingsFile): void {
    mkdirSync(dataRoot(), { recursive: true });
    writeFileSync(chatSettingsPath(), JSON.stringify(file, null, 2), "utf8");
  }
}
