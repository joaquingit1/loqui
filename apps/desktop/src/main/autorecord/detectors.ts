/**
 * PRD-11 — platform detectors behind a small INJECTABLE interface.
 *
 * Detection is inherently OS-specific + best-effort, so it lives behind a tiny
 * {@link NativeMeetingProbe} the engine depends on. Tests inject a fake; main
 * injects the real OS probe ({@link createNativeMeetingProbe}). Every probe is
 * TOTAL: it NEVER throws and NEVER blocks — a probe failure yields "no signal"
 * (the safe default) so a detection miss can never break the app or block manual
 * control.
 *
 * ## What's implemented vs deferred (be honest)
 * - **Windows** (this dev box): process-name enumeration against the configurable
 *   allowlist via `tasklist` (best-effort, manual-verified). The mic-in-use
 *   probe is a SEAM — a real WASAPI audio-session check needs a native addon we
 *   do not build here, so the Windows probe reports `micActive:false` until that
 *   signal exists.
 * - **macOS**: running-apps + mic-in-use are SEAMS (NSWorkspace running apps +
 *   the CoreAudio "device in use" flag). The interface is the same; the macOS
 *   body is filled + verified on a Mac. Until then the macOS probe degrades to a
 *   process-name check plus `micActive:false`, parallel to Windows.
 * - **Browser**: NOT an OS probe — it comes from the PRD-6 extension over the
 *   EXISTING loopback WS (see ./browser-source.ts). No new socket.
 *
 * The async OS calls are debounced/cached by the engine's poll interval; the
 * probe itself just answers "right now, best-effort".
 */
import { exec } from "node:child_process";

/**
 * The injectable native-meeting probe. `sample` resolves the best-effort
 * native-app + mic state for the given allowlist. TOTAL — resolves with
 * `{ appActive:false, micActive:false }` on any failure, never rejects.
 */
export interface NativeMeetingProbe {
  /**
   * @param allowlist case-insensitive substrings matched against process/app names.
   * @returns whether an allowlisted conferencing app is running (`appActive`) and
   *   whether the mic/audio is best-effort considered active (`micActive`).
   */
  sample(allowlist: string[]): Promise<NativeProbeSample>;
}

export interface NativeProbeSample {
  /** An allowlisted conferencing app process is running. */
  appActive: boolean;
  /** The mic/audio is (best-effort) considered active. */
  micActive: boolean;
  /** The matched process name(s), for diagnostics (never secret). */
  matched: string[];
}

const EMPTY_SAMPLE: NativeProbeSample = { appActive: false, micActive: false, matched: [] };

/** Run a command, resolving its stdout (empty string on any error). TOTAL. */
function run(cmd: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    try {
      exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? "" : stdout);
      });
    } catch {
      resolve("");
    }
  });
}

/**
 * Match the allowlist (case-insensitive substring) against a newline-delimited
 * list of process names. Returns the distinct matched names.
 */
export function matchAllowlist(processNames: string[], allowlist: string[]): string[] {
  const needles = allowlist
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  if (needles.length === 0) return [];
  const matched = new Set<string>();
  for (const raw of processNames) {
    const name = raw.trim().toLowerCase();
    if (name === "") continue;
    for (const needle of needles) {
      if (name.includes(needle)) {
        matched.add(raw.trim());
        break;
      }
    }
  }
  return [...matched];
}

/** Parse `tasklist /fo csv /nh` stdout into bare process image names. */
export function parseTasklist(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // CSV rows look like: "zoom.exe","1234","Console","1","12,345 K"
    const first = trimmed.match(/^"([^"]*)"/);
    if (first?.[1]) names.push(first[1]);
  }
  return names;
}

/** Parse `ps -axco comm=` (macOS) / `ps -eo comm=` style stdout into names. */
export function parsePs(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * The real OS native probe for the current platform. Best-effort + manual
 * verified. The implementation is intentionally thin: process enumeration only.
 * A precise mic-in-use signal (WASAPI audio sessions on Windows, CoreAudio device
 * "in use" on macOS) is a native-addon SEAM left for Mac/CI verification — until
 * then `micActive` is always false so native auto-record stays inert instead of
 * treating an idle allowlisted app as a live call. Follow-up: wire Windows
 * CapabilityAccessManager ConsentStore / WASAPI or macOS CoreAudio "device in
 * use" before native auto-record can become live.
 */
export function createNativeMeetingProbe(
  platform: NodeJS.Platform = process.platform,
): NativeMeetingProbe {
  return {
    async sample(allowlist: string[]): Promise<NativeProbeSample> {
      try {
        let names: string[] = [];
        if (platform === "win32") {
          names = parseTasklist(await run("tasklist /fo csv /nh"));
        } else if (platform === "darwin" || platform === "linux") {
          names = parsePs(await run("ps -axco comm="));
        } else {
          return EMPTY_SAMPLE;
        }
        const matched = matchAllowlist(names, allowlist);
        const appActive = matched.length > 0;
        // A true mic-in-use probe is not available in this TS-only path. Keep
        // the injectable seam, but never infer mic activity from process presence.
        return { appActive, micActive: false, matched };
      } catch {
        return EMPTY_SAMPLE;
      }
    },
  };
}

/**
 * A no-op probe (always "no native signal"). The safe default the engine uses
 * when native detection is disabled in settings, and a convenient test stub.
 */
export function nullNativeProbe(): NativeMeetingProbe {
  return { sample: () => Promise.resolve(EMPTY_SAMPLE) };
}
