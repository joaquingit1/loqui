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
  it("renders ONE consolidated progress bar (no per-job breakdown)", () => {
    const jobs: JobProgressMap = {
      diarization: job({ kind: "diarization", state: "running", progress: 0.4 }),
      summary: job({ kind: "summary", state: "queued", progress: 0 }),
    };
    render(<ProcessingStatus jobs={jobs} active />);

    expect(screen.getByTestId("processing-status")).toBeTruthy();
    // A single progressbar, with a numeric value in range — no separate
    // diarization/summary rows.
    const bar = screen.getByTestId("processing-bar");
    expect(bar.getAttribute("role")).toBe("progressbar");
    const now = Number(bar.getAttribute("aria-valuenow"));
    expect(now).toBeGreaterThanOrEqual(0);
    expect(now).toBeLessThanOrEqual(100);
    expect(screen.queryByTestId("processing-job-diarization")).toBeNull();
    expect(screen.queryByTestId("processing-job-summary")).toBeNull();
  });

  it("snaps to 100% when no longer active (with a reported job)", () => {
    const jobs: JobProgressMap = { summary: job({ kind: "summary", state: "done", progress: 1 }) };
    render(<ProcessingStatus jobs={jobs} active={false} />);
    const bar = screen.getByTestId("processing-bar");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });

  it("surfaces a hard error instead of a cheerful bar", () => {
    const jobs: JobProgressMap = {
      summary: job({ kind: "summary", state: "error", progress: 0.5, error: "provider failed" }),
    };
    render(<ProcessingStatus jobs={jobs} active />);
    expect(screen.getByTestId("processing-error").textContent).toContain("provider failed");
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

  it("ProcessingStatus surfaces a job error from the hook stream", () => {
    const bridge = makeBridge();
    function Harness(): JSX.Element {
      const { jobs } = useJobProgress({ api: bridge.api });
      return <ProcessingStatus jobs={jobs} active />;
    }
    render(<Harness />);
    // The single bar renders regardless of which job is running (no per-job rows).
    expect(screen.getByTestId("processing-bar")).toBeTruthy();
    bridge.emit(job({ kind: "summary", state: "error", progress: 0.5, error: "provider failed" }));
    expect(screen.getByTestId("processing-error").textContent).toContain("provider failed");
  });

  it("reduceJob is a pure accumulator (sanity)", () => {
    const m = reduceJob(reduceJob({}, job({ kind: "summary", state: "running" })), job({ kind: "summary", state: "done" }));
    expect(m.summary?.state).toBe("done");
  });
});
