/**
 * useJobProgress — subscribe to post-processing job progress (diarization +
 * summary) over the typed `window.loqui.postprocess.onJob` bridge and reduce it
 * into the latest state per job kind.
 *
 * READ-ONLY: this hook only listens; it never writes a transcript or meta file.
 * The bridge is injectable so component tests can drive scripted JobEvents
 * without window.loqui / Electron.
 */
import { useEffect, useRef, useState } from "react";
import type { JobEvent } from "@loqui/shared";
import type { LoquiPostProcessApi } from "../../preload/index.js";
import { reduceJob, type JobProgressMap } from "./model.js";

export interface UseJobProgressOptions {
  /** Postprocess bridge (subset). Defaults to window.loqui.postprocess. */
  api?: Pick<LoquiPostProcessApi, "onJob">;
  /** Called once per incoming JobEvent (e.g. to refetch summary on done). */
  onEvent?: (event: JobEvent) => void;
}

export interface UseJobProgressResult {
  /** Latest JobEvent per tracked job kind (diarization | summary). */
  jobs: JobProgressMap;
}

export function useJobProgress(options: UseJobProgressOptions = {}): UseJobProgressResult {
  const { api, onEvent } = options;
  const [jobs, setJobs] = useState<JobProgressMap>({});

  // Keep the latest onEvent in a ref so re-subscribing isn't tied to its identity.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const bridge =
      api ?? (typeof window !== "undefined" ? window.loqui?.postprocess : undefined);
    if (!bridge?.onJob) return;
    const unsubscribe = bridge.onJob((event: JobEvent) => {
      setJobs((prev) => reduceJob(prev, event));
      onEventRef.current?.(event);
    });
    return unsubscribe;
  }, [api]);

  return { jobs };
}
