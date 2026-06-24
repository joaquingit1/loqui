/**
 * @file Main-process Google Meet speaker-name attribution (PRD-6) public surface.
 *
 * FOUNDATION SEAM: this barrel re-exports ONLY the contract types/signatures the
 * three PRD-6 Build units implement against (the loopback WS server, the PURE
 * correlation engine, the name-applier that REUSES the PRD-5 diarized-rewrite
 * path, and the IPC bridge + correlation hook). The concrete implementations are
 * added by the Build phase as sibling modules and re-exported here, exactly like
 * ./mcp/index.ts and ./calendar/index.ts.
 *
 * INVARIANTS re-asserted at the module boundary:
 *  - GRACEFUL DEGRADATION: nothing here may throw into Meet or break the meeting;
 *    an absent/broken extension => the meeting completes with generic `Speaker N`.
 *  - LOOPBACK ONLY: the WS server binds 127.0.0.1 only.
 *  - NAME-APPLY REUSE: the applier touches ONLY the diarized files +
 *    meta.participants via the PRD-5 path; transcript.live.md / transcript.jsonl
 *    stay byte-identical, and MANUAL renames always win.
 *  - The Python sidecar is NOT involved (TS-only).
 */
export type {
  ActiveMeetingSource,
  BufferedMeetingActivity,
  ExtensionWsServer,
  ExtensionWsServerDeps,
  CreateExtensionWsServer,
  CorrelateSpeakerNames,
  SpeakerNameApplierStore,
  SpeakerNameApplier,
  SpeakerNamesIpcDeps,
  RegisterSpeakerNamesIpc,
  SpeakerNamesCorrelationHookDeps,
  RunSpeakerNamesCorrelation,
} from "./types.js";

// Concrete implementations (Build unit "main-ws-correlation-merge").
export { createExtensionWsServer, activeMeetingFromController } from "./ws-server.js";
export { correlateSpeakerNames } from "./correlate.js";
export { applySpeakerNames } from "./apply.js";
export {
  registerSpeakerNamesIpc,
  runSpeakerNamesCorrelation,
  subscribeSpeakerNamesCorrelation,
} from "./register.js";
