/**
 * Secure Hugging Face token storage (PRD-5).
 *
 * Import as: `import { HfKeystore } from "../postprocess/hf-keystore.js"`
 *
 * pyannote's speaker-diarization weights are gated behind a Hugging Face token.
 * That token is a SECRET: it is encrypted with Electron `safeStorage` (OS
 * keychain-backed — Keychain on macOS, DPAPI on Windows) and persisted as an
 * opaque base64 blob — NEVER plaintext on disk, and NEVER logged or returned to
 * the renderer.
 *
 * It reuses the EXACT PRD-4 safeStorage mechanism (the {@link SafeStorageLike}
 * surface + the `basic_text` refusal) but writes to its OWN file so it does not
 * touch the chat keystore (the chat keystore's key map is scoped to the
 * `ChatProvider` enum and cannot hold an `huggingface` entry). main reads the
 * decrypted token here and forwards it transiently to the sidecar on each
 * postProcess request; the renderer never sees it.
 *
 * Files (under the resolved data root, honoring LOQUI_DATA_DIR so tests stay
 * hermetic):
 *   <dataRoot>/postprocess-settings.json   — { hfToken: <b64 ciphertext> }
 *
 * There is NO transcript surface here — this module constructs only
 * postprocess-settings.json (never a meeting transcript/meta path), so it
 * structurally cannot read or write a transcript/meta file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  diarizationBackendStatusSchema,
  hfTokenStatusSchema,
  setDiarizationBackendParamsSchema,
  type DiarizationBackendPreference,
  type DiarizationBackendStatus,
  type HfTokenStatus,
  type SetDiarizationBackendParams,
  type SetHfTokenParams,
} from "@loqui/shared";
import { dataRoot } from "../store/paths.js";

/**
 * The subset of Electron `safeStorage` this module needs (injectable for tests).
 * Identical shape to the PRD-4 chat keystore's {@link
 * import("../chat/keystore.js").SafeStorageLike} so production can pass the SAME
 * `safeStorage` instance.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /**
   * Linux only: which OS backend safeStorage chose. `basic_text` is
   * hardcoded-key obfuscation (NOT real encryption) yet still reports
   * `isEncryptionAvailable() === true`, so we refuse it (a token would land
   * effectively plaintext). Optional/absent on macOS + Windows.
   */
  getSelectedStorageBackend?(): string;
}

/** On-disk shape of `postprocess-settings.json`. `hfToken` is base64 ciphertext. */
interface PostProcessSettingsFile {
  hfToken?: string;
  diarizationBackend?: DiarizationBackendPreference;
}

const POSTPROCESS_SETTINGS_FILE = "postprocess-settings.json";

function postProcessSettingsPath(): string {
  return join(dataRoot(), POSTPROCESS_SETTINGS_FILE);
}

export class HfKeystore {
  readonly #safeStorage: SafeStorageLike;

  constructor(safeStorage: SafeStorageLike) {
    this.#safeStorage = safeStorage;
  }

  /**
   * Store (or clear, on an empty/null token) the HF token, encrypted via
   * safeStorage. Returns only whether a token is now stored — NEVER the token.
   * Throws if encryption is unavailable / the insecure `basic_text` backend is
   * in use (caller surfaces an error).
   */
  setHfToken(params: SetHfTokenParams): HfTokenStatus {
    const file = this.#readFile();
    const raw = params.token ?? "";
    if (raw.trim() === "") {
      // Clear.
      delete file.hfToken;
      this.#writeFile(file);
      return hfTokenStatusSchema.parse({ hasToken: false });
    }
    if (!this.#safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage encryption is not available on this system");
    }
    const backend = this.#safeStorage.getSelectedStorageBackend?.();
    if (backend === "basic_text") {
      throw new Error(
        "safeStorage is using the insecure 'basic_text' backend; refusing to store the Hugging Face token in plaintext. Install/unlock a system keyring (e.g. gnome-keyring or kwallet) and retry.",
      );
    }
    file.hfToken = this.#safeStorage.encryptString(raw).toString("base64");
    this.#writeFile(file);
    return hfTokenStatusSchema.parse({ hasToken: true });
  }

  /** Whether an HF token is currently stored (never returns the token). */
  getHfTokenStatus(): HfTokenStatus {
    const file = this.#readFile();
    return hfTokenStatusSchema.parse({ hasToken: Boolean(file.hfToken) });
  }

  setDiarizationBackend(params: SetDiarizationBackendParams): DiarizationBackendStatus {
    const parsed = setDiarizationBackendParamsSchema.parse(params);
    const file = this.#readFile();
    file.diarizationBackend = parsed.diarizationBackend;
    this.#writeFile(file);
    return diarizationBackendStatusSchema.parse({
      diarizationBackend: parsed.diarizationBackend,
    });
  }

  getDiarizationBackendStatus(): DiarizationBackendStatus {
    return diarizationBackendStatusSchema.parse({
      diarizationBackend: this.getDiarizationBackend(),
    });
  }

  getDiarizationBackend(): DiarizationBackendPreference {
    const file = this.#readFile();
    const parsed = diarizationBackendStatusSchema.safeParse({
      diarizationBackend: file.diarizationBackend,
    });
    return parsed.success ? parsed.data.diarizationBackend : "auto";
  }

  /**
   * Decrypt + return the stored HF token, or null if none stored (or decryption
   * fails). main calls this to inject the transient token into a postProcess
   * request; the value is never logged or returned to the renderer.
   */
  getHfToken(): string | null {
    const file = this.#readFile();
    const b64 = file.hfToken;
    if (!b64) return null;
    if (!this.#safeStorage.isEncryptionAvailable()) return null;
    try {
      return this.#safeStorage.decryptString(Buffer.from(b64, "base64"));
    } catch {
      return null;
    }
  }

  #readFile(): PostProcessSettingsFile {
    try {
      const raw = readFileSync(postProcessSettingsPath(), "utf8");
      const parsed = JSON.parse(raw) as PostProcessSettingsFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      // Corrupt file: start fresh rather than crash the surface.
      return {};
    }
  }

  #writeFile(file: PostProcessSettingsFile): void {
    mkdirSync(dataRoot(), { recursive: true });
    writeFileSync(postProcessSettingsPath(), JSON.stringify(file, null, 2), "utf8");
  }
}
