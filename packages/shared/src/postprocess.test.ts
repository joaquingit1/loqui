import { describe, expect, it } from "vitest";
import { postProcessRequestSchema } from "./postprocess.js";

describe("postProcessRequestSchema", () => {
  it("defaults diarizationBackend to auto", () => {
    const parsed = postProcessRequestSchema.parse({ meetingId: "m1" });
    expect(parsed.diarizationBackend).toBe("auto");
  });

  it("accepts explicit diarizationBackend choices", () => {
    expect(
      postProcessRequestSchema.parse({
        meetingId: "m1",
        diarizationBackend: "sherpa",
      }).diarizationBackend,
    ).toBe("sherpa");
    expect(
      postProcessRequestSchema.parse({
        meetingId: "m1",
        diarizationBackend: "pyannote",
      }).diarizationBackend,
    ).toBe("pyannote");
  });
});
