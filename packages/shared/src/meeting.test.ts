import { describe, expect, it } from "vitest";
import { meetingSchema, meetingKindSchema, createMeetingInputSchema } from "./meeting.js";

const baseMeeting = {
  id: "11111111-1111-1111-1111-111111111111",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
};

describe("meetingSchema kind discriminator (PRD-12)", () => {
  it("defaults kind to 'meeting' when absent (old meta.json loads forward)", () => {
    const parsed = meetingSchema.parse(baseMeeting);
    expect(parsed.kind).toBe("meeting");
  });

  it("round-trips each kind value through the schema", () => {
    for (const kind of ["meeting", "import", "voice-memo"] as const) {
      const parsed = meetingSchema.parse({ ...baseMeeting, kind });
      expect(parsed.kind).toBe(kind);
      // Re-parsing the serialized form preserves the kind (store round-trip).
      const reparsed = meetingSchema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(reparsed.kind).toBe(kind);
    }
  });

  it("rejects an unknown kind", () => {
    expect(() => meetingSchema.parse({ ...baseMeeting, kind: "podcast" })).toThrow();
  });

  it("meetingKindSchema defaults to 'meeting'", () => {
    expect(meetingKindSchema.parse(undefined)).toBe("meeting");
  });

  it("createMeetingInput accepts an explicit kind", () => {
    const parsed = createMeetingInputSchema.parse({ kind: "import", title: "clip.m4a" });
    expect(parsed.kind).toBe("import");
  });
});
