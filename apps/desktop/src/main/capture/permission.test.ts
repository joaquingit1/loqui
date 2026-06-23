import { describe, expect, it, vi } from "vitest";
import {
  SCREEN_SETTINGS_DEEP_LINK,
  isCaptureBlocked,
  needsPermissionUi,
  needsRestartAfterGrant,
  openScreenSettings,
  resolveScreenPermission,
  type RawMediaAccessStatus,
} from "./permission.js";

describe("resolveScreenPermission", () => {
  it("returns not-applicable on non-macOS regardless of getter", () => {
    expect(
      resolveScreenPermission({ platform: "win32", getMediaAccessStatus: () => "denied" }),
    ).toBe("not-applicable");
    expect(resolveScreenPermission({ platform: "linux" })).toBe("not-applicable");
  });

  it("passes through the recognized macOS statuses", () => {
    const cases: RawMediaAccessStatus[] = ["granted", "denied", "restricted", "not-determined"];
    for (const raw of cases) {
      expect(
        resolveScreenPermission({ platform: "darwin", getMediaAccessStatus: () => raw }),
      ).toBe(raw);
    }
  });

  it("maps unknown -> not-determined (prompt, don't block)", () => {
    expect(
      resolveScreenPermission({ platform: "darwin", getMediaAccessStatus: () => "unknown" }),
    ).toBe("not-determined");
  });

  it("falls back to not-determined when no getter and on macOS", () => {
    expect(resolveScreenPermission({ platform: "darwin" })).toBe("not-determined");
  });

  it("treats a throwing getter as not-determined (never throws)", () => {
    expect(
      resolveScreenPermission({
        platform: "darwin",
        getMediaAccessStatus: () => {
          throw new Error("boom");
        },
      }),
    ).toBe("not-determined");
  });
});

describe("status predicates", () => {
  it("isCaptureBlocked is true only for denied/restricted", () => {
    expect(isCaptureBlocked("denied")).toBe(true);
    expect(isCaptureBlocked("restricted")).toBe(true);
    expect(isCaptureBlocked("granted")).toBe(false);
    expect(isCaptureBlocked("not-determined")).toBe(false);
    expect(isCaptureBlocked("not-applicable")).toBe(false);
  });

  it("needsPermissionUi is true for denied/restricted/not-determined", () => {
    expect(needsPermissionUi("denied")).toBe(true);
    expect(needsPermissionUi("restricted")).toBe(true);
    expect(needsPermissionUi("not-determined")).toBe(true);
    expect(needsPermissionUi("granted")).toBe(false);
    expect(needsPermissionUi("not-applicable")).toBe(false);
  });
});

describe("needsRestartAfterGrant", () => {
  it("is true only when status reads granted but capture failed", () => {
    expect(needsRestartAfterGrant("granted", true)).toBe(true);
    expect(needsRestartAfterGrant("granted", false)).toBe(false);
    expect(needsRestartAfterGrant("denied", true)).toBe(false);
    expect(needsRestartAfterGrant("not-determined", true)).toBe(false);
  });
});

describe("openScreenSettings", () => {
  it("opens the screen-recording deep link on macOS", async () => {
    const openExternal = vi.fn(async () => undefined);
    const res = await openScreenSettings({ platform: "darwin", openExternal });
    expect(res.ok).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(SCREEN_SETTINGS_DEEP_LINK);
  });

  it("is a no-op on non-macOS", async () => {
    const openExternal = vi.fn(async () => undefined);
    const res = await openScreenSettings({ platform: "win32", openExternal });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("not-applicable");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("reports ok:false when no shell is available", async () => {
    const res = await openScreenSettings({ platform: "darwin" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("no_shell");
  });

  it("surfaces a failed open as ok:false (never throws)", async () => {
    const res = await openScreenSettings({
      platform: "darwin",
      openExternal: async () => {
        throw new Error("settings unavailable");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("open_failed");
    expect(res.message).toContain("settings unavailable");
  });
});
