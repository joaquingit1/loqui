/**
 * PRD-8 — the updater manager: owns the periodic-check timer + the settings sink
 * and wraps the {@link UpdaterEngine}. The bootstrap wires this; the IPC bridge
 * binds the `window.loqui.updater` surface to it.
 *
 * Behavior (PRD-8): with `autoCheck` ON (the default) it checks on launch and
 * then every `intervalMs` (floored at {@link MIN_UPDATE_CHECK_INTERVAL_MS}). The
 * user can disable auto-check (only "Check for updates now" runs then) and tune
 * the interval; changes apply live. Every check is best-effort and SAFE — a
 * failure never disturbs the installed app, it only updates the state.
 */
import {
  MIN_UPDATE_CHECK_INTERVAL_MS,
  type UpdaterSettings,
  type UpdaterState,
} from "@loqui/shared";
import { UpdaterEngine, type UpdaterEngineDeps } from "./engine.js";

/** The settings slice the manager needs (a slice of SettingsStore). */
export interface UpdaterSettingsSink {
  getUpdaterSettings(): UpdaterSettings;
  setUpdaterSettings(patch: Partial<UpdaterSettings>): UpdaterSettings;
}

export interface UpdaterManagerDeps extends UpdaterEngineDeps {
  settings: UpdaterSettingsSink;
  /** setTimeout/clearTimeout seam (tests use fake timers). */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
}

export class UpdaterManager {
  private readonly engine: UpdaterEngine;
  private readonly settings: UpdaterSettingsSink;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (h: ReturnType<typeof setInterval>) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private readonly deps: UpdaterManagerDeps) {
    this.settings = deps.settings;
    this.setIntervalFn = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h));
    this.engine = new UpdaterEngine(deps, this.settings.getUpdaterSettings());
  }

  /** The current updater runtime state. */
  getState(): UpdaterState {
    return this.engine.getState();
  }

  /** The current persisted updater settings. */
  getSettings(): UpdaterSettings {
    return this.settings.getUpdaterSettings();
  }

  /**
   * Start the manager: kick an initial check (if auto-check is on) and arm the
   * interval timer. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const settings = this.settings.getUpdaterSettings();
    this.engine.applySettings(settings);
    if (settings.autoCheck) {
      void this.engine.checkNow();
      this.arm(settings.intervalMs);
    }
  }

  /** Check for updates NOW (the on-demand "Check for updates" action). */
  async checkNow(): Promise<UpdaterState> {
    return this.engine.checkNow();
  }

  /** Apply a settings patch live: persists, re-arms the timer. */
  setSettings(patch: Partial<UpdaterSettings>): UpdaterSettings {
    const merged = this.settings.setUpdaterSettings(patch);
    this.engine.applySettings(merged);
    this.disarm();
    if (this.started && merged.autoCheck) this.arm(merged.intervalMs);
    return merged;
  }

  /** Apply a staged update + quit (the "Restart to update" action). */
  quitAndInstall(): void {
    this.engine.quitAndInstall();
  }

  /** Stop the timer (app quit). Idempotent. */
  dispose(): void {
    this.disarm();
    this.started = false;
  }

  private arm(intervalMs: number): void {
    const ms = Math.max(MIN_UPDATE_CHECK_INTERVAL_MS, intervalMs);
    this.timer = this.setIntervalFn(() => {
      void this.engine.checkNow();
    }, ms);
    // Don't keep the process alive solely for the poll.
    const t = this.timer as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  private disarm(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }
}
