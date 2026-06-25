# PRD-16 — UI/UX Rehaul (macOS-centric design system + app shell)

## Goal
Give Loqui a **refined, light, macOS-native look and feel** built on a single
**authoritative design system**, and re-house the existing app inside a proper
**macOS app shell** (left sidebar + main content, traffic-light-aware chrome).
This is the visual/structural foundation for the product: an elegant serif for
display/headings, a clean system sans for UI/body, generous whitespace, soft
rounded cards, hairline borders, and a restrained muted accent — the language of
the two reference designs in `docs/design/reference/`.

This PRD is **multi-phase**. **Phase 1 (this build)** establishes the foundation —
the design system, the design tokens in code, and the app-shell chrome — **without
rewriting the inner views or changing any behaviour**. Later phases re-skin each
view (Home, Library/past-meeting, live Meeting) on top of the foundation.

## Background
The renderer (`apps/desktop/src/renderer/`) today is a **dark**, single-column,
720px-centered layout: a top header (title + tagline + sidecar badge), a
horizontal tab bar (`Home / Meeting / Library / Settings`, styled in
`home/home.css`), and stacked `.panel` cards. Styling is plain CSS driven by a
small set of CSS custom properties in `styles.css` `:root` (`--bg`, `--panel`,
`--panel-border`, `--text`, `--text-dim`, `--accent`, `--green`, `--amber`,
`--red`, `--slate`, `--sans`, `--mono`). Every per-feature stylesheet
(`home.css`, `library.css`, `meeting.css`, `chat.css`, `summary.css`,
`transcript.css`, `capture.css`) consumes those tokens.

All data reaches the renderer through the typed `window.loqui` bridge
(PRD-0..15). The rehaul is **purely visual and structural** — no data flow,
no IPC, no `window.loqui` contract changes.

The target aesthetic (derived from `docs/design/reference/ref-1.png` and
`ref-2.png`): macOS traffic-light window, near-white neutral surfaces, a subtle
warm peach→cream hero gradient (ref-1), muted **sage-green** accent with a soft
filled active-nav pill (ref-2), an elegant **serif** for big greetings/numbers/
headings and a clean **grotesque/sans** for everything else, ~12–16px card radii,
soft shadows + hairline borders, line icons, a **left sidebar** (wordmark →
line-icon nav → secondary links + user/avatar at the bottom) beside a main
content region.

## Target UX (the product the rehaul is building toward)
> Phase 1 establishes the shell + system; the bullets below describe the *eventual*
> experience that later phases fill in. They are the design intent the foundation
> must support, not all Phase-1 deliverables.

- **App shell (Phase 1):** a macOS window with traffic-light controls and a
  draggable title region; a **left sidebar** carrying the **Loqui wordmark**
  (serif), **line-icon primary nav** for the existing views with an **active
  soft accent pill**, and a **bottom area** for sidecar status + Settings +
  a user/avatar slot; a **main content region** that hosts whichever view is
  active. All four existing views stay reachable and fully functional.
- **Home (later):** a calm landing with a **serif greeting** ("Good
  afternoon, …") over a subtle warm hero gradient, a one-line **"meetings
  ahead"** summary, today's/upcoming meetings as soft cards, and quick actions
  (start/record). Built on PRD-15 calendar data.
- **Sidebar past-meetings (later):** the left rail also surfaces **recent past
  meetings** (like ref-1's RECENTS) that are **clickable**; clicking one opens
  that meeting's **summary** in the main region with a **chat interface below**
  to ask questions about it (PRD-3 summary + PRD-4 chat).
- **Live Meeting (later):** starting a meeting / recording shows the **live
  transcript flowing in real time** with a **real-time ask-questions chat**
  alongside (PRD-2/3/4), all inside the new shell.
- **Settings (later):** the existing settings panels re-skinned to the system.

## Scope / deliverables — Phase 1 (this build)
1. **This PRD** (`docs/prd/PRD-16-ui-rehaul.md`).
2. **Authoritative design system** (`docs/design/DESIGN-SYSTEM.md`): the exact
   palette, typography (serif display + sans UI families, type scale), spacing
   scale, radii, shadows/elevation, border treatment, motion/easing, and
   component specs (sidebar, nav item, card, pill/button, segmented control,
   input, list row, avatar, badge, status dot). It states the **hard rule** that
   all frontend work consumes these tokens — no ad-hoc colours/sizes.
3. **Design tokens in code:** the system implemented as **CSS custom
   properties** in `apps/desktop/src/renderer/styles.css` `:root` — the single
   source of truth the per-feature CSS consumes. macOS-native font stacks
   (system serif `ui-serif`/"New York"/Georgia for display; `-apple-system`/
   `system-ui`/"SF Pro" for UI) with clean cross-platform fallbacks. All token
   names currently consumed by per-feature CSS are **preserved** (re-pointed to
   the new light palette) so nothing breaks; new tokens are added alongside.
4. **macOS app-shell chrome:** restyle `App.tsx` from the top header + tab bar
   into the **sidebar + main content** shell described above, with the macOS
   window feel (traffic-light inset, draggable title region via
   `-webkit-app-region`). **All four views stay reachable**, the **sidecar
   status badge**, navigation, and all `window.loqui` data flows are intact.
5. **Behaviour-preserving:** the renderer↔`window.loqui` contract is unchanged;
   view internals are **not** rewritten (later phases). Affected component tests
   (esp. `App.test.tsx`) are updated/extended to pass with the new shell.

## Out of scope (Phase 1)
- Rewriting the internals of Home, Library, Meeting, or Settings views (later
  phases). Phase 1 only re-houses them in the shell + re-points the tokens.
- The sidebar **past-meetings list**, the **summary+chat-below** surface, and the
  **live transcript + real-time chat** layouts (later phases).
- Any new `window.loqui` surface, IPC, model, or data source.
- Dark-mode theming (the references are light; tokens are structured so a dark
  theme can be layered later, but it is not built now).
- New third-party fonts, icon packages, or any logos/brand assets lifted from the
  reference screenshots (tokens and icons are **original**).

## Acceptance criteria
1. `docs/prd/PRD-16-ui-rehaul.md` and `docs/design/DESIGN-SYSTEM.md` exist and
   the design system is authoritative (palette, type, spacing, radii, shadows,
   motion, component specs, and the "consume the tokens" rule).
2. The design tokens are implemented as CSS custom properties in `styles.css`
   `:root`; **every token name previously consumed by per-feature CSS is still
   defined** (re-pointed to the light palette), so all existing views render
   without missing-variable breakage.
3. The app shell is the **left sidebar + main content** macOS layout: Loqui
   serif wordmark, line-icon primary nav with an active accent pill, a bottom
   area with the **sidecar status badge** + Settings + user/avatar slot, and a
   draggable title region. The window reads as macOS-native and matches the
   reference visual language (light surfaces, serif display, soft cards, hairline
   borders, sage accent).
4. **All four views remain reachable and functional** via the sidebar
   (`home / meeting / library / settings`), each rendered inside the main region.
   The sidecar status badge still updates live from `onSidecarStatus`. No
   `window.loqui` data flow changes.
5. `App.test.tsx` (and any other affected component test) passes against the new
   shell structure; nav testids (`app-nav`, `nav-*`), the `sidecar-status`
   badge, and the per-view root testids are preserved.
6. **Gate green:** `@loqui/shared` build, `-r typecheck`, `-r lint`, the desktop
   Vitest suite, and the sidecar pytest suite all pass. (`smoke:mcp` is a known
   local-harness caveat, not in scope.)
7. **Invariants intact:** renderer talks only to `window.loqui`; no transcript
   writes; nothing leaves the machine; the rehaul is additive + behaviour-
   preserving.

## Phased build plan
- **Phase 1 — Foundation (this build):** PRD + design system + tokens in code +
  the macOS app shell; existing views re-housed unchanged; tests green.
- **Phase 2 — Home view:** serif greeting + warm hero gradient + "meetings ahead"
  + today/upcoming meeting cards + quick actions, on PRD-15 calendar data.
- **Phase 3 — Sidebar past-meetings + meeting detail:** recent past meetings in
  the sidebar (clickable), opening a meeting's **summary + chat-below** surface
  (PRD-3 + PRD-4).
- **Phase 4 — Live Meeting:** the live transcript-flowing + real-time
  ask-questions layout (PRD-2/3/4) inside the shell.
- **Phase 5 — Settings + polish:** re-skin the settings panels; motion,
  empty/loading states, accessibility pass, optional dark theme.

## Notes for implementers
- **Tokens are law.** Every colour, size, radius, shadow, and font in any
  frontend change must come from a token in `styles.css` `:root` per
  `DESIGN-SYSTEM.md`. No ad-hoc hex/px in feature CSS.
- **Preserve the seam.** The renderer only uses `window.loqui`; do not touch the
  preload/IPC boundary for visual work.
- **Re-house, don't rewrite.** In Phase 1, change the shell + tokens only; leave
  each view's component internals (and their testids) intact so later phases can
  re-skin them deliberately.
- **macOS-first, cross-platform-safe.** Use system font stacks and
  `-webkit-app-region` for the chrome; keep Windows/light fallbacks clean (the
  app also ships on Windows 10+).
- **Original assets only.** Derive tokens from the references' *language*; do not
  embed their logos, wordmarks, or brand colours verbatim.
