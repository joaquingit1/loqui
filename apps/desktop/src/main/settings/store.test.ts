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
