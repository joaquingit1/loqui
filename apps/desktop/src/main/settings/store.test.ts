/**
 * PRD-13 SettingsStore tests (hermetic temp LOQUI_DATA_DIR).
 *
 * Asserts the additive + defaulted capture/privacy settings: defaults
 * (content-protection ON, retention "keep", per-app off), partial patches merge,
 * an older/empty config loads forward, and the export-dir resolution.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_ENV } from "@loqui/shared";
import { SettingsStore, defaultExportDir } from "./store.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loqui-settings-"));
  process.env[DATA_DIR_ENV] = tmp;
});

afterEach(() => {
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("returns the defaults when no file exists (content protection ON)", () => {
    const s = new SettingsStore();
    const settings = s.getCaptureSettings();
    expect(settings.contentProtection).toBe(true);
    expect(settings.audioRetention).toBe("keep");
    expect(settings.perAppAudioFilter).toBe(false);
    expect(settings.exportDir).toBeNull();
  });

  it("persists + merges partial patches", () => {
    const s = new SettingsStore();
    const a = s.setCaptureSettings({ audioRetention: "delete-after-processing" });
    expect(a.audioRetention).toBe("delete-after-processing");
    // A second partial patch must not reset the first.
    const b = s.setCaptureSettings({ contentProtection: false });
    expect(b.contentProtection).toBe(false);
    expect(b.audioRetention).toBe("delete-after-processing");
    // Re-reading from a fresh instance reflects the persisted file.
    expect(new SettingsStore().getCaptureSettings()).toEqual(b);
  });

  it("loads an older/partial config forward with defaults", () => {
    // Simulate an app-settings.json written before some fields existed.
    writeFileSync(
      join(tmp, "app-settings.json"),
      JSON.stringify({ capture: { audioRetention: "never-save" } }),
      "utf8",
    );
    const settings = new SettingsStore().getCaptureSettings();
    expect(settings.audioRetention).toBe("never-save");
    expect(settings.contentProtection).toBe(true); // defaulted
    expect(settings.perAppAudioFilter).toBe(false); // defaulted
  });

  it("resolves the export dir (default when unset, override when set)", () => {
    const s = new SettingsStore();
    expect(s.getExportDir()).toBe(defaultExportDir());
    s.setCaptureSettings({ exportDir: join(tmp, "my-exports") });
    expect(s.getExportDir()).toBe(join(tmp, "my-exports"));
  });

  it("survives a corrupt settings file (falls back to defaults)", () => {
    writeFileSync(join(tmp, "app-settings.json"), "{ not json", "utf8");
    expect(() => new SettingsStore().getCaptureSettings()).not.toThrow();
    expect(new SettingsStore().getCaptureSettings().contentProtection).toBe(true);
  });
});

describe("SettingsStore — auto-record (PRD-11)", () => {
  it("defaults to MANUAL-ONLY (auto-record disabled) when no file exists", () => {
    const ar = new SettingsStore().getAutoRecordSettings();
    expect(ar.enabled).toBe(false);
    expect(ar.onDetect).toBe("ask");
    expect(ar.autoStopDelayMs).toBe(5000);
    expect(ar.silenceTimeoutMs).toBe(0); // silence stop is opt-in
    expect(ar.appAllowlist).toContain("zoom");
    expect(ar.launchAtLogin).toBe(false);
    expect(ar.runInBackground).toBe(false);
  });

  it("persists + merges auto-record patches independently of capture settings", () => {
    const s = new SettingsStore();
    s.setCaptureSettings({ contentProtection: false });
    const a = s.setAutoRecordSettings({ enabled: true, onDetect: "auto" });
    expect(a.enabled).toBe(true);
    expect(a.onDetect).toBe("auto");
    // A second partial patch must not reset the first, nor touch capture settings.
    const b = s.setAutoRecordSettings({ silenceTimeoutMs: 90_000 });
    expect(b.enabled).toBe(true);
    expect(b.silenceTimeoutMs).toBe(90_000);
    expect(new SettingsStore().getCaptureSettings().contentProtection).toBe(false);
    expect(new SettingsStore().getAutoRecordSettings()).toEqual(b);
  });

  it("loads an older config (no autoRecord key) forward as manual-only", () => {
    writeFileSync(
      join(tmp, "app-settings.json"),
      JSON.stringify({ capture: { audioRetention: "keep" } }),
      "utf8",
    );
    expect(new SettingsStore().getAutoRecordSettings().enabled).toBe(false);
  });
});

describe("SettingsStore — updater (PRD-8)", () => {
  it("defaults to auto-check ON, ~30 min interval, auto-download ON", () => {
    const u = new SettingsStore().getUpdaterSettings();
    expect(u.autoCheck).toBe(true);
    expect(u.intervalMs).toBe(30 * 60 * 1000);
    expect(u.autoDownload).toBe(true);
  });

  it("persists + merges updater patches independently of other settings", () => {
    const s = new SettingsStore();
    s.setAutoRecordSettings({ enabled: true });
    const a = s.setUpdaterSettings({ autoCheck: false });
    expect(a.autoCheck).toBe(false);
    expect(a.intervalMs).toBe(30 * 60 * 1000); // untouched
    const b = s.setUpdaterSettings({ intervalMs: 10 * 60 * 1000 });
    expect(b.autoCheck).toBe(false); // first patch preserved
    expect(b.intervalMs).toBe(10 * 60 * 1000);
    // Other settings groups are unaffected.
    expect(new SettingsStore().getAutoRecordSettings().enabled).toBe(true);
    expect(new SettingsStore().getUpdaterSettings()).toEqual(b);
  });

  it("loads an older config (no updater key) forward with auto-check ON", () => {
    writeFileSync(
      join(tmp, "app-settings.json"),
      JSON.stringify({ capture: { audioRetention: "keep" } }),
      "utf8",
    );
    expect(new SettingsStore().getUpdaterSettings().autoCheck).toBe(true);
  });
});
