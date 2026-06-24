/**
 * @file Main-process Calendar integration (PRD-15) public surface. FOUNDATION.
 *
 * Re-exports the calendar seams the main wiring + Build units import from one
 * place: the {@link CalendarProvider}/{@link CalendarService}/{@link CalendarTokenStore}
 * interfaces (types.ts) and the {@link registerCalendarIpc} bridge (register.ts).
 * Build unit A adds the FakeCalendarProvider + Google/Microsoft/Zoom providers,
 * the service + token-store implementations, and the wiring factory.
 *
 * INVARIANT (re-asserted at the module boundary): nothing exported here writes a
 * calendar (read-only scope) or a transcript file. All provider HTTP is behind
 * the injectable {@link CalendarProvider}; any loopback OAuth listener binds
 * 127.0.0.1 only. OAuth tokens live in the safeStorage keystore and never reach
 * the renderer.
 */
export { registerCalendarIpc } from "./register.js";
export { createCalendarService } from "./service.js";
export type { CalendarServiceImpl, CreateCalendarServiceDeps } from "./service.js";
export {
  FakeCalendarProvider,
  GoogleProvider,
  MicrosoftProvider,
  ZoomProvider,
} from "./providers.js";
export type {
  CalendarHttp,
  RealProviderDeps,
  FakeCalendarProviderOptions,
} from "./providers.js";
export { CalendarKeystore } from "./token-store.js";
export type {
  CalendarProvider,
  CalendarProviderRegistry,
  CalendarService,
  CalendarTokenStore,
  CalendarOAuthTokens,
  CalendarConnectOutcome,
  CalendarIpcDeps,
  RegisterCalendarIpc,
  SafeStorageLike,
} from "./types.js";
