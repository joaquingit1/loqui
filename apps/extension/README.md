# Loqui — Meet Speaker Names (browser extension)

A Manifest V3 browser extension that reads **Google Meet's participant list** and
**active-speaker indicator** and streams `{ts, name, speaking}` events to the
Loqui desktop app over a **loopback (127.0.0.1) WebSocket** — only while a meeting
is active. Loqui's main process correlates those events with the diarized
transcript to replace generic `Speaker N` labels with real participant names.

> **No audio, no recording.** This extension never reads or records audio — Loqui
> captures audio itself. It only reads names and the speaking indicator, and only
> talks to `127.0.0.1` (your own machine).

## Graceful degradation (the #1 invariant)

This is the most fragile part of Loqui because it depends on Google Meet's DOM,
which changes without notice. It is built to **degrade, never break**:

- If the extension is **not installed**, Loqui still completes the meeting with
  generic `Speaker N` labels.
- If a **selector misses** (Meet changed its DOM), the content script reads
  nothing that tick and sends nothing — it never throws into the Meet page.
- If **Loqui isn't running** (the loopback socket is refused), the client retries
  quietly with backoff and never blocks Meet.
- A **manual rename** in Loqui always wins over an auto-resolved name.

## Build

```bash
corepack pnpm --filter @loqui/extension build      # one-shot -> dist/
corepack pnpm --filter @loqui/extension dev        # watch mode
```

The build (esbuild) bundles `src/content.ts` into a single classic IIFE
`dist/content.js` and copies `src/manifest.json` to `dist/`. The `dist/` folder is
a loadable unpacked extension. The WS endpoint constants are mirrored locally (see
`src/contract.ts`) so the injected bundle stays tiny and ships **no zod** into the
Meet page; `src/contract.test.ts` guards those mirrors against the `@loqui/shared`
contract.

## Install / pairing (one-time)

1. Build the extension (`corepack pnpm --filter @loqui/extension build`).
2. Open your browser's extensions page (`chrome://extensions`,
   `edge://extensions`, or `brave://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this package's `dist/` folder.
5. Start (or have running) the **Loqui desktop app** — it hosts the loopback WS
   server on `127.0.0.1:7345`.
6. Join a **Google Meet** call and start recording in Loqui. The Loqui UI shows a
   "names being captured" indicator when the extension is connected.

No sign-in, no account, no cloud — the extension only connects to your local Loqui
app. Pairing is implicit: the extension dials `127.0.0.1:7345` and Loqui
associates the connected Meet tab with the meeting you're currently recording.

## Permissions

Minimal by design — see `src/manifest.json`:

- `host_permissions`: `https://meet.google.com/*` only.
- `permissions`: **none** (no `tabs`, no `tabCapture`, no `audioCapture`, no
  storage, no broad host access).

The content script connects to a loopback WebSocket on the page's own JS context;
no extra extension permission is required for an outbound `ws://127.0.0.1` socket.

## Selectors (the swappable, volatile part)

Every Google Meet DOM query lives in **one** module, `src/meet/selectors.ts`,
behind the `MeetSelectors` interface, with a date-stamped `MEET_SELECTOR_VERSION`
(reported to Loqui in the `hello` frame so a regression is attributable). When
Meet changes its DOM, update only that module + a fixture — nothing else moves.
See `src/meet/fixtures/README.md` for the step-by-step selector update process.

## Layout

| File | Role |
| --- | --- |
| `src/manifest.json` | MV3 manifest (meet.google.com host only, zero permissions). |
| `src/content.ts` | Injected entry: wires selectors + sender + watcher; top-level try/catch. |
| `src/contract.ts` | Local mirror of the WS endpoint constants (keeps zod out of the bundle). |
| `src/ws-client.ts` | Loopback WS client (`createMeetEventSender`): connect, backoff, queue, teardown. |
| `src/meet/selectors.ts` | **Swappable** DOM selectors (`createDomMeetSelectors`) — the only Meet-DOM code. |
| `src/meet/watcher.ts` | Read/diff/emit loop (`createMeetWatcher`): one `activity` per speaking toggle. |
| `src/meet/page.ts` | URL meeting-code + participant-root helpers. |
| `src/meet/fixtures/` | Captured Meet HTML + a tiny hermetic DOM for the selector tests. |
| `scripts/build.ts` | esbuild bundle + manifest staging. |

## Tests

```bash
corepack pnpm --filter @loqui/extension test
corepack pnpm --filter @loqui/extension typecheck
```

All hermetic — no live Meet, no real network. Selector tests parse captured
fixture HTML through a tiny in-process DOM (this package has no jsdom and installs
nothing); the WS-client tests use a fake in-process socket; the watcher tests use
a fake selectors object + manual clock.
