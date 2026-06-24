# Loqui — Frontend ↔ Backend Contract

> **Audience:** the engineer building the renderer/UI in parallel with the backend.
> **Status:** stable for PRD-0..5 (capture, transcription, library, chat, diarization+summaries). Sections marked **PROPOSED** are not built yet — build against them only after they're confirmed (see the bottom).
> **Authoritative source:** this doc summarizes the code. The compile-time truth is `@loqui/shared` (data models) + the `LoquiApi` type in `apps/desktop/src/preload/index.ts` (the API). When in doubt, the types win — import them, don't copy them.

---

## 1. Architecture in one picture

```
Renderer (React/TS)  ──window.loqui──▶  Main (Electron/Node)  ──loopback WS──▶  Python sidecar
   • all UI                              • owns ALL persistence        • faster-whisper x2
   • talks ONLY to window.loqui          • meeting store + SQLite FTS   • pyannote diarization
   • never imports electron/node         • spawns/supervises sidecar    • AI provider layer
   • never references IPC channels        • OS keychain (keys/tokens)    • summarizer
```

**Hard rules for the renderer (enforced by the architecture — please don't fight them):**
- The renderer talks to **`window.loqui` only**. No `ipcRenderer`, no `require`, no Node globals (`contextIsolation: true`, `sandbox: true`).
- **The AI never edits the transcript.** There is no API that lets chat/summary write a transcript. Treat `getTranscript` / `getDiarizedTranscript` / `getSummary` as read-only.
- The **mic stream = "You"**, the **system stream = "They"** — kept separate end-to-end. Segments carry `source: "mic" | "system"`.

## 2. How to consume the contract

```ts
// Data models (zod schemas + inferred TS types + JSON Schemas):
import type { Meeting, TranscriptSegment, Summary, DiarizedTranscript, ProviderConfig } from "@loqui/shared";
import { meetingSchema, listMeetingsQuerySchema } from "@loqui/shared"; // runtime validation if you want it

// The API surface (typed):
import type { LoquiApi } from "../preload"; // window.loqui is `LoquiApi`
// In components, just call: window.loqui.library.listMeetings(...), etc.
```

`packages/shared` also emits JSON Schemas (`pnpm --filter @loqui/shared build` / the emit script) if you need them for anything non-TS.

## 3. The `window.loqui` API (what the renderer calls)

`invoke` = async request/response (returns a Promise). `push` = main→renderer event; you subscribe with an `on*` method that **returns an unsubscribe function** (call it in `useEffect` cleanup). `send` = fire-and-forget (no round-trip; the reply comes back as a push).

### Top level
| Method | Kind | Signature | Notes |
|---|---|---|---|
| `ping()` | invoke | `() => Promise<{ok, latencyMs}>` | round-trips main→sidecar→back |
| `getSidecarHealth()` | invoke | `() => Promise<Health \| null>` | null if not connected |
| `onSidecarStatus(cb)` | push | `(status: "connecting"\|"connected"\|"disconnected"\|"error") => void` | drive the status badge |
| `onTranscriptSegment(cb)` | push | `(seg: TranscriptSegment) => void` | **live** transcript; see §5 |

### `library` — meeting lifecycle + the "previous meetings" list (PRD-3, **built**)
| Method | Kind | Signature | Notes |
|---|---|---|---|
| `startMeeting(params?)` | invoke | `({title?, platform?}) => Promise<Meeting>` | status → `recording`, sets `startedAt` |
| `stopMeeting({id})` | invoke | `=> Promise<Meeting>` | status → `processing` then `done` |
| `listMeetings(query?)` | invoke | `({from?, to?, query?, limit?}) => Promise<Meeting[]>` | **newest-first**; this is the "all previous meetings" list. `from`/`to` are inclusive ISO bounds on `createdAt` |
| `searchMeetings(query)` | invoke | `(string) => Promise<MeetingSearchHit[]>` | FTS over title + transcript + summary; each hit has `{meeting, snippet}` |
| `getTranscript({id, variant?})` | invoke | `=> Promise<string>` | `variant: "live"` (Markdown, default) \| `"structured"` (JSONL) |
| `renameMeeting({id, title})` | invoke | `=> Promise<Meeting>` | persists to meta + index |
| `onMeetingStatus(cb)` | push | `(meeting: Meeting) => void` | full updated Meeting on each transition — update lists without re-fetching |

### `chat` — in-call AI chat (PRD-4, **built**). Read-only over the transcript.
| Method | Kind | Signature | Notes |
|---|---|---|---|
| `send(params)` | send | `({chatId, meetingId, messages, providerConfig}) => void` | mint a `chatId` (UUID) yourself; reply streams back on `onStream` |
| `onStream(cb)` | push | `(ev: ChatStreamEvent) => void` | union: `{kind:"token", delta}` \| `{kind:"done", text, provider, model}` \| `{kind:"error", code, message}`. **Filter by `ev.chatId`** |
| `getProviderSettings()` / `setProviderSettings(cfg)` | invoke | `=> Promise<ProviderConfig>` | non-secret settings only |
| `setApiKey({provider, apiKey})` | invoke | `=> Promise<ApiKeyStatus>` | stores in OS keychain; empty string clears; **never echoes the key** |
| `getApiKeyStatus(provider?)` | invoke | `=> Promise<{provider, hasKey}>` | |

- `messages` you send is the conversation **without** any transcript context — the sidecar injects the (read-only) transcript itself. Don't ship transcript text through chat.
- Providers: `anthropic` (BYOK), `ollama` (local), `agent-cli` (local Claude Code/Codex), `fake` (tests). No `temperature`/`top_p`/`budget_tokens` knobs — deliberately absent.

### `postprocess` — diarization + summaries (PRD-5, **built**). Read-only over the transcript.
| Method | Kind | Signature | Notes |
|---|---|---|---|
| `onJob(cb)` | push | `(job: JobUpdate) => void` | `{jobId, kind:"diarization"\|"summary", state, progress 0..1, error?}` — drive progress UI |
| `getSummary({meetingId})` | invoke | `=> Promise<Summary \| null>` | null until generated |
| `getDiarizedTranscript({meetingId})` | invoke | `=> Promise<DiarizedTranscript \| null>` | null until diarized |
| `renameSpeaker({meetingId, speaker, displayName})` | invoke | `=> Promise<DiarizedTranscript>` | `"Speaker 1"` → `"Alex"`; empty `displayName` clears |
| `regenerateSummary({meetingId})` | invoke | `=> Promise<void>` | progress via `onJob` |
| `setHfToken({token})` / `getHfTokenStatus()` | invoke | `=> Promise<{hasToken}>` | HF token for pyannote; keychain; never echoed |

### `audio` — capture bridge (PRD-1, **built**, mostly driven by the capture hook)
`startCapture` / `stopCapture` / `sendFrame` (hot path) / `getScreenPermission` / `onScreenPermission`. The UI usually drives this through the existing `useCapture` / `useMeetingCapture` hooks rather than calling raw — see `renderer/capture/`.

## 4. Core data models (`@loqui/shared`)

**`Meeting`** — the canonical record (`meta.json` + index row). Every field defaulted (old records parse forward).
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `title` | string | |
| `platform` | `"google-meet"\|"zoom"\|"teams"\|"other"\| null` | set on start when known |
| `startedAt` / `endedAt` | ISO 8601 \| null | |
| `status` | `"recording"\|"processing"\|"done"\|"error"` | see §6. **No "scheduled" state** — meetings exist only once recording starts |
| `participants` | `{id, name, speakerLabel}[]` | names filled by PRD-6 / speaker rename |
| `modelVersions` | `Record<string,string>` | stage → model id |
| `createdAt` / `updatedAt` | ISO 8601 | |

**`TranscriptSegment`** (live push): `{meetingId, source:"mic"|"system", text, tStart, tEnd, status:"partial"|"final", segId}`.

**`DiarizedTranscript`**: `{meetingId, diarized, backend, speakers:string[], segments: {segId, source, text, tStart, tEnd, speaker, displayName}[]}`. `speaker` is `"You"` for mic, `"Speaker N"` for system clusters.

**`Summary`**: `{meetingId, tldr, decisions:string[], actionItems:{text, owner}[], topics:string[], provider, model, generatedAt}`.

**`ProviderConfig`**: `{provider, model, baseUrl, ollamaModel, cli}` (no secrets — key lives in keychain).

## 5. Live transcript rendering (the subtle bit)

`onTranscriptSegment` fires for both `partial` and `final` segments, for both sources independently:
- A `partial` segment **updates in place** and is later **superseded by a `final` with the same `segId`**. So key your rendered segments by `segId`, replace on each event, and style `partial` as tentative.
- Route by `source`: `mic` → "You" lane, `system` → "They" lane.
- The on-disk `transcript.live.md` (via `getTranscript`) only ever contains **final** segments; the live stream is where partials show.

## 6. Meeting lifecycle / state machine

```
startMeeting() → status "recording"  (live segments stream via onTranscriptSegment)
stopMeeting()  → status "processing" (onJob: diarization then summary, progress 0..1)
               → status "done"        (getDiarizedTranscript / getSummary now non-null)
               → status "error"       (graceful-degrade: meeting still completes with whatever succeeded)
```
Subscribe to `library.onMeetingStatus` to react to every transition with the full updated `Meeting`.

---

## 7. Home / "Today's upcoming meetings" + Calendar integration — **committed (PRD-15), in build**

**Decided:** providers are **Google Calendar + Microsoft 365 / Outlook + Zoom** (read-only); this is a new PRD ([PRD-15](../prd/PRD-15-calendar-home.md)) being built now. Until its Foundation lands the code in `@loqui/shared`, build the Home view against the **committed shape below** (mock the data via a fake `listToday()`); the contract will not change shape. The "previous meetings" Library uses the **real** `library.listMeetings()` today.

This reads *scheduled* events (with Meet/Zoom/Teams join links) — distinct from PRD-6 (in-call name scraping) and PRD-11 (detecting a call happening *now*).

```ts
// @loqui/shared model (committed; lands in PRD-15 Foundation). Additive + defaulted.
interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;        // ISO 8601
  endsAt: string;          // ISO 8601
  platform: "google-meet" | "zoom" | "teams" | "other" | null;
  joinUrl: string | null;  // the Meet/Zoom/Teams link, if any
  attendees: { name: string; email: string | null }[];
  source: "google" | "microsoft" | "zoom";
  calendarAccount: string; // which connected account this came from
  meetingId: string | null; // linked once a recording exists for this event
}

// window.loqui.calendar namespace (committed; lands in PRD-15)
interface LoquiCalendarApi {
  listToday(): Promise<CalendarEvent[]>;                                  // today's events, soonest-first
  listUpcoming(params?: { withinHours?: number; limit?: number }): Promise<CalendarEvent[]>;
  connect(provider: "google" | "microsoft" | "zoom"): Promise<{ connected: boolean; account?: string }>;
  disconnect(provider: "google" | "microsoft" | "zoom", account?: string): Promise<void>;
  getConnections(): Promise<{ provider: "google" | "microsoft" | "zoom"; account: string; lastSyncAt: string | null }[]>;
  refresh(): Promise<CalendarEvent[]>;                                    // force a re-sync
  onUpdated(cb: (events: CalendarEvent[]) => void): () => void;           // push when the event set changes
}
```

**Home view shape (frontend owns the navigation shell):** Home (Today + Upcoming peek + connect/empty state) ↔ Library (past meetings) ↔ active Meeting. A "join & record" action on a today's-event row opens `joinUrl` and calls `library.startMeeting(...)` pre-filled from the event. OAuth connect flows + token storage are handled in main (keychain) — the renderer just calls `connect(provider)` and renders `getConnections()`.
