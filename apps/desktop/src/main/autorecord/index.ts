/**
 * @file Main-process auto-record on meeting detection + menubar/tray (PRD-11).
 *
 * Public surface for the feature, re-exporting the pure decision core, the
 * injectable platform detectors, the browser in-call source (PRD-6 WS reuse), the
 * orchestration engine, the IPC bridge, and the tray. Mirrors ./speakernames,
 * ./calendar, ./mcp.
 *
 * INVARIANTS re-asserted at the module boundary:
 *  - MANUAL-FIRST: auto-record is OFF by default; with it off the app is exactly
 *    PRD-3 (manual start/stop). Nothing here ever blocks manual control.
 *  - The decision CORE is PURE + deterministic (no I/O, no Date.now); the OS
 *    probes are injectable + TOTAL (a failed probe is "no signal", never a crash).
 *  - REUSE: start/stop go through the PRD-3 lifecycle; the browser signal rides
 *    the EXISTING PRD-6 loopback WS (no new socket).
 */
export {
  decide,
  initialDecisionState,
  meetingPresent,
  type DecisionState,
  type DecisionPolicy,
  type DecisionResult,
} from "./decision.js";
export {
  createNativeMeetingProbe,
  nullNativeProbe,
  matchAllowlist,
  parseTasklist,
  parsePs,
  type NativeMeetingProbe,
  type NativeProbeSample,
} from "./detectors.js";
export {
  browserCallSourceFromWsServer,
  nullBrowserCallSource,
  type BrowserCallSource,
} from "./browser-source.js";
export {
  createAutoRecordEngine,
  autoRecordDisabledState,
  AUTO_RECORD_DEFAULT_POLL_MS,
  type AutoRecordEngine,
  type AutoRecordEngineDeps,
  type AutoRecordLifecycle,
} from "./engine.js";
export {
  registerAutoRecordIpc,
  type AutoRecordIpcDeps,
  type AutoRecordSettingsSink,
} from "./register.js";
export {
  createTray,
  createTrayElectron,
  buildTrayTemplate,
  iconStateFor,
  tooltipFor,
  type TrayController,
  type TrayActions,
  type TrayModel,
  type TrayElectron,
  type TrayInstance,
  type TrayMenuItem,
  type TrayRecentMeeting,
} from "./tray.js";
