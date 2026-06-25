/**
 * Capture adapter for the meeting lifecycle (PRD-3).
 *
 * Bridges the PRD-1 {@link createCaptureController} to the imperative
 * {@link MeetingCaptureControl} shape {@link useMeetingController} expects.
 * Unlike the PRD-1 `useCapture` hook (which (re)creates its controller from a
 * `meetingId` *prop* via an effect), this adapter creates the controller
 * *imperatively* the instant the meeting id is known — closing the timing race
 * between `startMeeting()` resolving and capture beginning.
 *
 * `startAll(meetingId)` builds a fresh controller for that meeting and starts
 * BOTH sources (mic + system) in parallel; per-source failures surface through
 * the controller's status (the level meters / errors), not as a thrown rejection,
 * so a denied system-audio permission never aborts the mic stream. `stopAll()`
 * tears every source + the controller down.
 *
 * The controller factory + env are injectable so this is unit-testable without a
 * real microphone (jsdom has no getUserMedia / AudioWorklet).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioSource, LoquiAudioApi } from "@loqui/shared";
import {
  createCaptureController,
  type CaptureController,
  type CaptureControllerDeps,
  type CaptureStatus,
} from "../capture/index.js";

const IDLE: CaptureStatus = { state: "idle", level: 0 };
const SOURCES: readonly AudioSource[] = ["mic", "system"];

export interface UseMeetingCaptureOptions {
  /** The audio bridge (window.loqui.audio). Tests inject a fake. */
  audio: LoquiAudioApi;
  /** Mic device id from a picker (undefined = system default). */
  micDeviceId?: string;
  /** Inject a controller factory for tests (defaults to the real one). */
  createController?: (deps: CaptureControllerDeps) => CaptureController;
}

export interface UseMeetingCaptureResult {
  /** Per-source status snapshots for the meters / error display. */
  statuses: Record<AudioSource, CaptureStatus>;
  /**
   * Build a controller for `meetingId` and start the given `sources` (defaults to
   * both). PRD-12 voice memos pass `["mic"]` so NO system stream is opened.
   */
  startAll(meetingId: string, sources?: readonly AudioSource[]): Promise<void>;
  /** Stop both sources and dispose the controller. */
  stopAll(): Promise<void>;
  /**
   * Toggle mute for one source (PRD-13). Returns the new muted state (false if no
   * controller is live). The controller stops forwarding that source's frames
   * while muted; the change surfaces through `statuses[source].muted`.
   */
  toggleMute(source: AudioSource): boolean;
}

export function useMeetingCapture(
  opts: UseMeetingCaptureOptions,
): UseMeetingCaptureResult {
  const { audio, micDeviceId } = opts;
  const factory = opts.createController ?? createCaptureController;

  const [statuses, setStatuses] = useState<Record<AudioSource, CaptureStatus>>({
    mic: IDLE,
    system: IDLE,
  });

  const controllerRef = useRef<CaptureController | null>(null);
  const mountedRef = useRef(true);

  // Tear any live controller down on unmount so a navigated-away meeting leaks
  // nothing.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void controllerRef.current?.stopAll();
      controllerRef.current = null;
    };
  }, []);

  const startAll = useCallback(
    async (meetingId: string, sources: readonly AudioSource[] = SOURCES): Promise<void> => {
      // Dispose any prior controller (defensive — normally idle here).
      await controllerRef.current?.stopAll();

      const controller = factory({
        audio,
        meetingId,
        micDeviceId,
        onStatus: (source, status) => {
          if (!mountedRef.current) return;
          setStatuses((prev) => ({ ...prev, [source]: status }));
        },
      });
      controllerRef.current = controller;
      setStatuses({ mic: IDLE, system: IDLE });

      // Start the requested sources independently; one rejecting must not stop the
      // other. (The controller already catches per-source errors into status, but
      // we settle defensively in case a custom controller rejects.) A voice memo
      // passes ["mic"] so the system stream is NEVER opened (mic-only by design).
      await Promise.allSettled(sources.map((s) => controller.start(s)));
    },
    [audio, micDeviceId, factory],
  );

  const stopAll = useCallback(async (): Promise<void> => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    await controller?.stopAll();
    if (mountedRef.current) setStatuses({ mic: IDLE, system: IDLE });
  }, []);

  const toggleMute = useCallback((source: AudioSource): boolean => {
    return controllerRef.current?.toggleMute(source) ?? false;
  }, []);

  return { statuses, startAll, stopAll, toggleMute };
}
