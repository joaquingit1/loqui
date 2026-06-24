/**
 * ProcessingStatus render tests (jsdom). HERMETIC: the jobs map is supplied
 * directly (presentational), and a second suite drives the useJobProgress hook
 * with a controllable onJob bridge to assert progress reflects JobUpdate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { JobEvent } from "@loqui/shared";
import { ProcessingStatus } from "./ProcessingStatus.js";
import { reduceJob, useJobProgress, type JobProgressMap } from "../summary/index.js";
import type { LoquiPostProcessApi } from "../../preload/index.js";

afterEach(cleanup);

const job = (over: Partial<JobEvent>): JobEvent => ({
  jobId: "j",
  kind: "diarization",
  state: "running",
  progress: 0,
  error: null,
  ...over,
});

describe("ProcessingStatus (presentational)", () => {
  it("renders a row per post-processing job kind with state + percent", () => {
    const jobs: JobProgressMap = {
      diarization: job({ kind: "diarization", state: "running", progress: 0.4 }),
      summary: job({ kind: "summary", state: "queued", progress: 0 }),
    };
    render(<ProcessingStatus jobs={jobs} />);

    expect(screen.getByTestId("processing-status")).toBeTruthy();
    const diar = screen.getByTestId("processing-job-diarization");
    expect(diar.getAttribute("data-state")).toBe("running");
    expect(diar.getAttribute("data-progress")).toBe("40");
    expect(screen.getByTestId("processing-job-state-diarization").textContent).toContain("40%");

    expect(screen.getByTestId("processing-job-summary").getAttribute("data-state")).toBe("queued");
  });

  it("shows a done job at 100% and an error job with its message", () => {
    const jobs: JobProgressMap = {
      diarization: job({ state: "done", progress: 1 }),
      summary: job({ kind: "summary", state: "error", progress: 0.5, error: "provider failed" }),
    };
    render(<ProcessingStatus jobs={jobs} />);
    expect(screen.getByTestId("processing-job-diarization").getAttribute("data-state")).toBe("done");
    expect(screen.getByTestId("processing-job-state-summary").textContent).toContain("Failed");
    expect(screen.getByTestId("processing-job-error-summary").textContent).toContain(
      "provider failed",
    );
  });

  it("renders waiting placeholders while active with no jobs reported", () => {
    render(<ProcessingStatus jobs={{}} active />);
    expect(screen.getByTestId("processing-status")).toBeTruthy();
    expect(screen.getByTestId("processing-job-state-diarization").textContent).toContain("Waiting");
  });

  it("renders nothing when inactive and no jobs reported", () => {
    const { container } = render(<ProcessingStatus jobs={{}} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("useJobProgress + ProcessingStatus (reflects JobUpdate stream)", () => {
  function makeBridge(): { api: Pick<LoquiPostProcessApi, "onJob">; emit: (e: JobEvent) => void } {
    let cb: ((e: JobEvent) => void) | null = null;
    return {
      api: {
        onJob: (fn) => {
          cb = fn;
          return () => {
            cb = null;
          };
        },
      },
      emit: (e) => act(() => cb?.(e)),
    };
  }

  it("accumulates the latest event per kind and ignores transcription", () => {
    const bridge = makeBridge();
    const { result } = renderHook(() => useJobProgress({ api: bridge.api }));

    bridge.emit(job({ kind: "diarization", state: "running", progress: 0.25 }));
    bridge.emit(job({ kind: "summary", state: "queued" }));
    bridge.emit(job({ kind: "transcription", state: "running" }));
    expect(result.current.jobs.diarization?.progress).toBe(0.25);
    expect(result.current.jobs.summary?.state).toBe("queued");
    expect(result.current.jobs.transcription).toBeUndefined();

    bridge.emit(job({ kind: "diarization", state: "done", progress: 1 }));
    expect(result.current.jobs.diarization?.state).toBe("done");
  });

  it("ProcessingStatus updates as the hook receives JobUpdate events", () => {
    const bridge = makeBridge();
    function Harness(): JSX.Element {
      const { jobs } = useJobProgress({ api: bridge.api });
      return <ProcessingStatus jobs={jobs} />;
    }
    render(<Harness />);
    bridge.emit(job({ kind: "diarization", state: "running", progress: 0.6 }));
    expect(screen.getByTestId("processing-job-diarization").getAttribute("data-progress")).toBe(
      "60",
    );
    bridge.emit(job({ kind: "summary", state: "done", progress: 1 }));
    expect(screen.getByTestId("processing-job-summary").getAttribute("data-state")).toBe("done");
  });

  it("reduceJob is a pure accumulator (sanity)", () => {
    const m = reduceJob(reduceJob({}, job({ kind: "summary", state: "running" })), job({ kind: "summary", state: "done" }));
    expect(m.summary?.state).toBe("done");
  });
});
