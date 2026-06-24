# Meet DOM fixtures (PRD-6)

Captured Google Meet HTML used to test the swappable selectors in
`../selectors.ts` **hermetically** — the selector tests parse these files, never
a live Meet page.

## Adding / updating a fixture (the selector update process)

Meet's DOM changes without notice. When a selector breaks:

1. Open a real Meet call, open the participant panel, and have someone speak so
   the active-speaker indicator is visibly highlighted.
2. Save the relevant DOM subtree to `meet-<yyyy-mm-dd>.html` here (the
   participant panel + at least one highlighted active speaker).
3. Bump `MEET_SELECTOR_VERSION` (date-stamped) and update the query strings in
   `createDomMeetSelectors` (the Build unit's implementation in
   `../selectors.ts`) to match the new DOM.
4. Add/adjust a fixture test asserting `listParticipants` + `readActiveSpeakers`
   parse the new fixture. Keep older fixtures' tests where feasible so the
   selectors stay resilient across a Meet rollout.

A selector miss must **degrade, never throw**: the selector methods return `[]` /
`null` on a miss, the content script then sends nothing, and Loqui completes the
meeting with generic `Speaker N` labels.
