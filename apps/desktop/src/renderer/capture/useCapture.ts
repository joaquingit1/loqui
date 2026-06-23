/**
 * React glue for the {@link createCaptureController} (PRD-1).
 *
 * Keeps the controller in a ref (created once per meeting) and mirrors its
 * per-source status into React state so the UI re-renders on level/state
 * changes. Tears the controller down on unmount so nothing leaks across
 * meeting changes. The controller (and its Web-Audio env) is injectable for
 * tests; production binds to window.loqui.audio + the real browser globals.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioSource, LoquiAudioApi, ScreenPermissionStatus } from "@loqui/shared";
import {
  createCaptureController,
  type CaptureController,
  type CaptureControllerDeps,
  type CaptureStatus,
} from "./controller.js";

export interface UseCaptureOptions {
  audio: LoquiAudioApi;
  meetingId: string | null;
  micDeviceId?: string;
  /** Inject a controller factory + env for tests. */
  createController?: (deps: CaptureControllerDeps) => CaptureController;
}

export interface UseCaptureResult {
  statuses: Record<AudioSource, CaptureStatus>;
  screenPermission: ScreenPermissionStatus | null;
  start(source: AudioSource): Promise<void>;
  stop(source: AudioSource): Promise<void>;
  /** True while either source is starting/capturing. */
  anyActive: boolean;
}

const IDLE: CaptureStatus = { state: "idle", level: 0 };

export function useCapture(opts: UseCaptureOptions): UseCaptureResult {
  const { audio, meetingId, micDeviceId } = opts;
  const factory = opts.createController ?? createCaptureController;

  const [statuses, setStatuses] = useState<Record<AudioSource, CaptureStatus>>({
    mic: IDLE,
    system: IDLE,
  });
  const [screenPermission, setScreenPermission] = useState<ScreenPermissionStatus | null>(
    null,
  );

  const controllerRef = useRef<CaptureController | null>(null);

  // (Re)create the controller whenever the meeting (or device) changes; tear
  // down the previous one fully.
  useEffect(() => {
    if (!meetingId) {
      controllerRef.current = null;
      setStatuses({ mic: IDLE, system: IDLE });
      return;
    }
    const controller = factory({
      audio,
      meetingId,
      micDeviceId,
      onStatus: (source, status) =>
        setStatuses((prev) => ({ ...prev, [source]: status })),
    });
    controllerRef.current = controller;
    setStatuses({ mic: IDLE, system: IDLE });
    return () => {
      controllerRef.current = null;
      void controller.stopAll();
    };
  }, [audio, meetingId, micDeviceId, factory]);

  // Track the macOS screen-recording permission for the system-audio flow.
  useEffect(() => {
    let active = true;
    void audio.getScreenPermission().then((s) => {
      if (active) setScreenPermission(s);
    });
    const unsubscribe = audio.onScreenPermission((s) => setScreenPermission(s));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [audio]);

  const start = useCallback(async (source: AudioSource) => {
    await controllerRef.current?.start(source);
  }, []);
  const stop = useCallback(async (source: AudioSource) => {
    await controllerRef.current?.stop(source);
  }, []);

  const anyActive = useMemo(
    () =>
      (["mic", "system"] as const).some(
        (s) => statuses[s].state === "starting" || statuses[s].state === "capturing",
      ),
    [statuses],
  );

  return { statuses, screenPermission, start, stop, anyActive };
}
