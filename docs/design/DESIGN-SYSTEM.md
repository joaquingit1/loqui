# Loqui Design System (authoritative)

> **Single source of truth for Loqui's frontend.** Every colour, type size, space,
> radius, shadow, border, motion value, and icon in any renderer change MUST come
> from a token here, implemented as a CSS custom property in
> `apps/desktop/src/renderer/styles.css` `:root`. **No ad-hoc values, ever** — no
> raw hex, raw px font-sizes, bespoke radii/shadows, or inline icons/emoji in
> feature code. Need something new? Add the token here + in `:root` first.
>
> Derived by direct analysis of `docs/design/reference/ref-1.png` (warm editorial
> AI-assistant) and `ref-2.png` (calm sage dashboard). Target = the intersection of
> their language, rebuilt original. Token **names below are the existing `:root`
> names**; tokens marked **(NEW)** must be added.

---

## 0. North star

macOS-native, **light, airy, editorial, seamless**. It must feel like a native Mac
app with **vibrancy/glass**, not a web app: warm paper canvas, **translucent
frosted panels**, soft diffuse light, generous whitespace, an **editorial serif**
for the few large moments (greeting, page titles, big numbers, wordmark) over a
clean grotesque **sans** for everything functional, a single **muted sage** accent
used sparingly, and **thin monochrome line icons**.

Separate things with **space → translucency → soft shadow**, almost never a hard
border. Calm and desaturated; the accent is a whisper.

### The "never" list (the failures we are correcting)
- ❌ **No emoji**, and no colored/filled/multi-tone icons. Only the line-icon set (§8).
- ❌ **No pure `#000`/`#fff`** for text or canvas — use the warm inks/papers.
- ❌ **No flat "dead" greys** (`#888/#ccc/#eee`). Greys are the warm ink at reduced alpha.
- ❌ **No hard 1px solid borders** as the primary separator (space → soft shadow → translucent hairline).
- ❌ **No boxy small radii or heavy shadows.** Radii generous; shadows soft, warm, diffuse.
- ❌ **No default OS form controls** (date/checkbox/select/scrollbar) — all tokenized (§9.7).
- ❌ **No cramped layouts** and **no "AI-app" tropes** (gradient text, neon/purple, glow, robot clip-art, dark chrome).

---

## 1. Colour

Warm-neutral, light. The canvas is *paper*, not white; greys are the ink at reduced
alpha so nothing reads "dead".

### 1.1 Surfaces (back → front)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#FBF8F3` | app canvas (warm off-white) |
| `--surface-sunken` | `#F4F0E9` | wells, inset/track backgrounds |
| `--panel` | `#FFFEFB` | opaque card (glass fallback) |
| `--panel-glass` **(NEW)** | `rgba(255,254,251,0.78)` | default translucent card over the wash |
| `--sidebar-bg` | `rgba(247,243,237,0.55)` | translucent sidebar (over vibrancy) |
| `--raised` **(NEW)** | `#FFFFFF` | elevated chip: active nav pill, focused composer |
| `--scrim` **(NEW)** | `rgba(34,30,26,0.38)` | modal/overlay scrim (with blur) |

### 1.2 Ink (warm near-black → faint)
| Token | Value | Use |
|---|---|---|
| `--text` | `#26221E` | primary text + serif headings |
| `--text-dim` | `#6E665B` | secondary text, labels, inactive nav |
| `--text-faint` | `#A89E90` | tertiary, placeholders, overlines |
| `--text-muted` **(NEW)** | `#C9C0B3` | disabled, faint dividers |
| `--accent-contrast` | `#FFFFFF` | text/icon on the accent fill |

### 1.3 Accent — muted sage (used sparingly)
| Token | Value | Use |
|---|---|---|
| `--accent` | `#6F8A72` | primary actions, active indicators |
| `--accent-strong` | `#5C7660` | hover/pressed accent |
| `--accent-ink` **(NEW)** | `#4E6A54` | accent-coloured *text* on paper (AA) |
| `--accent-tint` | `rgba(111,138,114,0.12)` | subtle tint fills (hover, selected rows) |
| `--accent-ring` **(NEW)** | `rgba(111,138,114,0.35)` | focus ring |

### 1.4 Status (desaturated, warm where possible)
`--green #5E8E6A` (connected/up) · `--amber #C2974C` (degraded) · `--red #BC6A5E`
(error/stop — warm terracotta, never harsh) · `--slate #6E7E86` (neutral info).
Keep the existing `*-soft` tint variants for fills.

**Vivid signal colours (NEW) — the two live "real action" moments only.** The
calm status palette above is for ambient/by-exception status. Two live affordances
earn a deliberately more saturated, confident colour so they read as *real
controls*, not muted decoration: **`--record-live #E0392B`** (the recording-in-
progress dot) and **`--send #2F9E6B` / `--send-strong #268457`** (the chat send
button fill). Use these ONLY here — nowhere else.

### 1.5 Hairlines (sparingly)
`--panel-border rgba(38,34,30,0.07)` (the only default hairline) ·
`--border-strong rgba(38,34,30,0.12)` (input outline, control track) ·
`--edge-light rgba(255,255,255,0.6)` **(NEW)** (inner top light edge on glass).

### 1.6 Hero wash (ref-1) — the Home signature
A diffuse warm wash that bleeds seamlessly into the canvas (no banding, no border):
```
--hero-gradient:
  radial-gradient(120% 90% at 88% 4%, #F7E0CB 0%, rgba(247,224,203,0) 46%),
  radial-gradient(110% 80% at 6% 96%, #F3E6DC 0%, rgba(243,230,220,0) 52%),
  var(--bg);
```

---

## 2. Typography

Serif = editorial moments only; sans = everything functional.

### 2.1 Families (macOS-native first; bundle Inter/Newsreader later for Windows parity)
```
--font-serif: ui-serif, "New York", "Newsreader", "Iowan Old Style", Georgia, serif;
--font-sans:  -apple-system, "SF Pro Text", "Inter", system-ui, "Segoe UI", sans-serif;
--font-mono:  "SF Mono", ui-monospace, "JetBrains Mono", "Cascadia Code", monospace;
```
On macOS the serif is **New York**, the sans **SF Pro** — the exact editorial +
grotesque pairing of the references.

### 2.2 Scale (size / line-height / weight / tracking / family)
| Token | px | LH | Wt | Track | Family | Use |
|---|---|---|---|---|---|---|
| `--text-display-xl` | 44 | 1.06 | 400 | -0.015em | serif | Home greeting |
| `--text-display-lg` | 34 | 1.1 | 400 | -0.013em | serif | rare splash |
| `--text-title` | 30 | 1.12 | 400 | -0.012em | serif | page titles |
| `--text-numeric` **(NEW)** | 38 | 1.0 | 400 | -0.01em | serif | big numbers |
| `--text-heading` | 22 | 1.22 | 600 | -0.006em | sans | section/card headings |
| `--text-subhead` **(NEW)** | 17 | 1.3 | 600 | -0.004em | sans | card titles, sub-heads |
| `--text-body-lg` **(NEW)** | 15 | 1.55 | 400 | 0 | sans | primary reading text / chat |
| `--text-body` | 14 | 1.55 | 400 | 0 | sans | default UI text |
| `--text-caption` | 13 | 1.5 | 400 | 0 | sans | descriptions, secondary |
| `--text-label` | 13 | 1.2 | 500 | 0 | sans | buttons, nav, field labels |
| `--text-overline` | 11 | 1.2 | 600 | +0.09em | sans | UPPERCASE section labels, `--text-faint` |
| `--text-mono` **(NEW)** | 12.5 | 1.4 | 400 | 0 | mono | timestamps, ids |

Serif is reserved for the greeting, page titles, the wordmark, and large numerics —
**never** for body, buttons, labels, or anything ≤ 17px.

---

## 3. Spacing & layout
4px base: `--space-1..12` = 4,8,12,16,20,24,—,32,—,40,—,48.
`--sidebar-width 252px` · `--content-max 920px` · `--content-pad` = 40/32 (x/y) ·
`--titlebar-height 38px` · card padding 24 · card gap 20. Content is a **centered
column**, not edge-to-edge. ≥ 24px between blocks; 32–40px below a page title.

---

## 4. Radii (generous — anti-boxy)
`--radius-sm 10 · --radius-md 14 · --radius-lg 18 · --radius-xl 24 ·
--radius-2xl 28 (NEW) · --radius-pill 999`.
Rows/chips/nav → md · cards/panels → lg–xl · composer/hero → 2xl · buttons → md ·
pills/segmented/badges → pill.

---

## 5. Elevation (soft, warm, diffuse — prefer over borders)
Warm ink at very low alpha, large blur, ~0 spread → things *float on paper*.
```
--shadow-xs:  0 1px 2px rgba(38,34,30,0.04), 0 1px 1px rgba(38,34,30,0.03);
--shadow-sm:  0 8px 22px rgba(38,34,30,0.07), 0 2px 5px rgba(38,34,30,0.05);
--shadow-md:  0 14px 40px rgba(38,34,30,0.10), 0 3px 8px rgba(38,34,30,0.05);
--shadow-lg (NEW): 0 24px 60px rgba(38,34,30,0.14), 0 6px 16px rgba(38,34,30,0.06);
--shadow-focus: 0 0 0 3px var(--accent-ring);
```
Resting card → `--shadow-sm`, **no border**, inner `--edge-light` top. Hover lift →
`--shadow-md` + 1px up. Popover/active pill/focused composer → `--shadow-md`.

---

## 6. Glass / translucency (the "seamless, transparent" mandate)
The signature material — frosted, light, bright inner top edge.
```
--glass-bg (NEW):   rgba(251,248,243,0.66);
--glass-blur (NEW): saturate(150%) blur(26px);
/* recipe */ background: var(--glass-bg); -webkit-backdrop-filter: var(--glass-blur);
            backdrop-filter: var(--glass-blur);
            box-shadow: inset 0 1px 0 var(--edge-light), var(--shadow-sm);
```
**Where:** sidebar, top title region, the composer, popovers/menus, floating
panels. Content cards may use `--panel-glass` over the hero so the warm wash bleeds
through. **Native vibrancy:** the Electron `BrowserWindow` requests macOS
`vibrancy: 'under-window'` (and `backgroundMaterial` on Win11) with a transparent
body; the CSS recipe is the cross-platform fallback.

**Saturation + edge (PRD-16 macOS-skill).** `--glass-blur` saturates **180%**
(was 150%) so the translucent wash doesn't desaturate the warm hues behind it —
the macOS vibrancy convention. Glass surfaces/cards add the macOS signature
**0.5px ink ring** for crisp definition without a visible hard border, tokenized
as `--glass-edge: 0 0 0 0.5px var(--panel-border)` and layered into the box-shadow
ahead of the inner `--edge-light` + soft float (`.panel`, `.chat__composer`, the
`<kbd>` chip). This is "definition by hairline ring", not a border — consistent
with the "space → translucency → soft shadow → faint hairline" order.

---

## 7. Motion
`--ease-standard cubic-bezier(0.32,0.72,0,1)` · `--ease-out cubic-bezier(0.22,1,0.36,1)`
· `--duration-fast 120ms` · `--duration-base 200ms` · `--duration-slow 320ms`.
Animate opacity/transform only. Subtle lifts (≤2px). Respect
`prefers-reduced-motion: reduce`.

---

## 8. Iconography (NO EMOJI — cardinal rule)
A single shared **line-icon set** via an inline-SVG React `<Icon name>` component
(`renderer/components/Icon.tsx`).
- **Stroke 1.5**, `currentColor`, **no fill**, 24×24 viewBox, round caps/joins,
  optically centered; rendered at 16/18/20px; dims with `--text-dim/faint`.
- **v1 set:** `home, calendar, library, mic, message, search, settings, plus,
  chevron-down, chevron-right, sidebar, clock, user, link, sparkle, check,
  check-circle, dot, stop, play, pause, x, download, share, lock, refresh`.
- Original, geometric, consistent corner radius. Never an emoji, icon font, or
  multicolour glyph.

---

## 9. Components

**9.1 Window chrome** — full-width `--titlebar-height` region, `-webkit-app-region:
drag` (interactive children `no-drag`); leave the macOS traffic-light inset (~72px)
clear; transparent over glass/vibrancy.

**9.2 Sidebar** — `--sidebar-width`, glass (§6), no right border (faint
`--panel-border` only without vibrancy). Wordmark "Loqui" in serif ~22px below the
traffic-light inset. **Nav item:** 34px row, `--radius-md`, 18px line icon +
`--text-label`; default `--text-dim`; hover `--accent-tint` + `--text`; **active =
`--raised` chip + `--shadow-sm`**, icon `--accent-ink` (ref-2's elevated pill, not a
flat colored block). **Overline** sections (`--text-overline`/`--text-faint`).
**Recents row:** title `--text-label`/`--text` + date `--text-caption`/`--text-faint`,
`--radius-md`, hover `--accent-tint`, selected `--raised`+`--shadow-xs`. **Foot:**
status pill + Settings item + user row (24px avatar + name + `chevron-down`).

**9.3 Content & hero** — scrollable centered `--content-max` column, `--content-pad`.
Page title `--text-title` (serif). Home hero = full-bleed `--hero-gradient` with the
`--text-display-xl` greeting, fading seamlessly into canvas (no card border).

**9.4 Card** — `--panel-glass`/`--panel`, `--radius-lg/xl`, padding 24, `--shadow-sm`,
inner `--edge-light`, **no border by default**. Interactive: hover `--shadow-md` +
`translateY(-1px)` over `--duration-fast`. Title `--text-subhead`; support
`--text-caption`/`--text-dim`.

**9.5 Composer / big input (ref-1)** — `--radius-2xl` glass, padding 20, `--shadow-sm`
(focus → `--shadow-md` + `--shadow-focus`). Placeholder `--text-faint`. Bottom row:
left line-icon ghost buttons; right a context pill (`chevron-down`) + a circular
`--accent` send with an `--accent-contrast` arrow. Used for ALL chat input (home,
in-call, past-meeting).

**9.6 Buttons & pills** — **Primary:** `--accent` fill / `--accent-contrast`,
`--text-label`, `--radius-md`, h34, hover `--accent-strong`, `--shadow-xs`. **Ghost:**
transparent `--text-dim` → `--accent-tint`+`--text`. **Pill/tag:** `--radius-pill`,
`--text-label`. **Icon button:** 32px, `--radius-md`, ghost. **Segmented control:**
`--radius-pill` track in `--surface-sunken`; selected = `--raised` pill + `--shadow-xs`.

**9.7 Form controls (tokenized, never OS-default)** — **Text field:** `--panel`,
`--radius-md`, `--border-strong` 1px, h36; focus → `--shadow-focus` + `--accent-ring`.
**Select/date:** custom-styled to match (no raw `mm/dd/yyyy`). **Checkbox/radio:**
20px circle, `--border-strong` ring; checked `--accent` fill + `check` icon.
**Scrollbars:** thin 8px, transparent track, `--text-muted` thumb (→`--text-faint`
hover), `--radius-pill`, overlay, no arrows.

**9.8 Lists & rows** — `--radius-md`, padding 12/16, hover `--accent-tint`; primary
`--text-label`/`--text`, secondary `--text-caption`/`--text-faint`; separate by
*space* (faint `--panel-border` only when density demands).

**9.9 Status pill / badge** — `--radius-pill`, leading 6px `dot` in the status colour
over a soft wash; text `--text-dim`. Deltas use `--green`/`--red` + arrow.

**9.10 Chat & transcript** — **Message:** no hard bubbles — *you* = `--accent-tint`
`--radius-lg` block right-aligned; *AI* = plain `--text` left-aligned with a small
`sparkle`; measure ≤ 66ch, `--text-body-lg`. **Live transcript line:** faint
`--text-mono` timestamp + speaker label (`--text-label`; You `--accent-ink`, They
`--text-dim`) + text `--text-body-lg`; new lines fade/slide in (`--duration-base`),
auto-scroll. **Summary:** TL;DR/decisions/actions/topics as titled blocks; serif
`--text-numeric` for counts.

**9.11 Empty / loading / focus** — Empty: centered line icon `--text-muted` +
`--text-subhead` line + `--text-caption` hint + one primary action (never blank).
Loading: shimmer on `--surface-sunken` blocks (no spinners-as-content).
Focus-visible: always `--shadow-focus`. **UI disclosure:** secondary controls
(search/filters/toolbars) are HIDDEN until content exists — e.g. the Library's
search + date controls only appear once meetings exist; a genuinely empty
library shows the calm empty state alone (a date filter that returns nothing
keeps the controls so it can be cleared).

**9.12 Keyboard `<kbd>` hint chip** — A faint, tokenized chip showing a shortcut
next to its action (e.g. `⌘F` in the Library search field, `⌘N` on Start
meeting, `⌘⏎` in the chat composer). Tokens: `--surface-sunken` bg,
`--radius-sm`, `--text-faint` ink, `--font-mono` ~11px, the `--glass-edge` 0.5px
ring. On an accent fill it inverts to a translucent-white inset
(`.kbd--on-accent`, token `--kbd-on-accent-bg`). It is a quiet affordance, never an interactive control
(`aria-hidden`); the labelled button it sits on carries the accessible name.
Render via `<Kbd combo>` (`renderer/shortcuts/Kbd.tsx`); build `combo` from
`modKeyLabel()` so the glyph matches the platform (⌘ on macOS, Ctrl elsewhere).
Hints disclose progressively — they hide once the user starts typing / clears
the draft, so a resting surface stays calm.

---

## 10. Accessibility & quality bar
AA contrast for body/secondary on its surface; accent text uses `--accent-ink`,
never `--text-faint` on `--accent`. Every interactive element has hover +
`focus-visible`. Respect reduced-motion. Hit targets ≥ 28px. Renderer touches only
`window.loqui`.

## 11. Implementation contract
Tokens live in `styles.css :root` (single source of truth); feature CSS consumes
`var(--…)` only. Icons come from `components/Icon.tsx`. In review, grep the renderer
for emoji, raw hex, px font-sizes, and raw `box-shadow`/`border` colours — any
literal outside `:root` is a defect. Update this doc in the same change as any token.

---

## 12. Vibecoded tells (NEVER) → professional habits (ALWAYS)

Derived from a controlled A/B — the *same* app built vibecoded ("X") vs by a
professional ("Y") — plus review of our own screens. Y is a different product/theme;
do **not** copy it. Internalise the *tendencies*; they separate "AI-generated" from
"designed". When unsure, **remove, don't add.**

### 12.1 Colour & status
- **Near-monochrome + ONE restrained accent.** Never many saturated colours at once.
  `--accent` (sage) appears ONLY on: the active nav pill, primary buttons, the "You"
  speaker, and a single positive dot — nowhere decorative.
- **Status by EXCEPTION.** Only surface a status that needs attention (processing,
  error). The normal/"done" state is **quiet or implicit** — no badge. Never stamp a
  filled status pill on every row.
- **No filled colour badges as repeating row decoration.** Status = a small `dot` in
  the status colour, or muted text — the row stays calm.
- **No colour-tinted numerals for decoration.** Numbers are `--text`; labels `--text-faint`.

### 12.2 Hierarchy, density & restraint
- **Strong hierarchy:** exactly one prominent element per row/card (the title);
  everything else recedes via size + weight + `--text-dim/faint` + space.
- **Fewer data points per row.** One prominent line + at most ONE muted secondary
  line. Extra metadata (duration, exact counts) moves to the detail view or hover —
  not the list.
- **Generous, consistent vertical rhythm.** Equal row heights, consistent gaps;
  negative space is a feature, not waste.
- **Minimise distinct treatments per screen.** Every element must earn its place;
  prefer space over chrome. A screen with 3 calm treatments beats one with 8.

### 12.3 Components & affordances
- **Consolidate actions into a menu** — never expose every option as a row of pills
  (e.g. Export is one `Export ▾` button/menu, NOT 7 inline pills).
- **Pills are for toggles / filters / genuine tags only** (e.g. topics) — not for
  labels, owners, metadata, exports, or statuses. Owners/metadata are muted inline
  text, not pills.
- **Not everything needs a card.** Let content sit on the canvas with space; reserve
  cards for genuinely grouped, elevated content.
- **Quiet, seamless inputs.** Search/date controls are subtle and integrated; never a
  loud boxed field, and never a raw native `mm/dd/yyyy`/`select` chrome.
- **Minimal dividers.** Separate with space first; a faint `--panel-border` only when
  density truly demands it. No heavy rules.

### 12.4 Icons, type & numbers
- **Icon stroke optically matches the text weight** and recedes (icons are quiet
  metadata markers, never heavier/darker than their label).
- **Tight type ramp** — reuse the scale; don't invent sizes. Metadata aligns to a
  consistent column (icon + text pairs aligned).
- **Consistent number formatting** (tabular figures, consistent units/alignment).
- **Terse microcopy.** Trust the user; cut redundant captions and over-explanation.

### 12.5 Applied to Loqui (enforce now — these are the current defects)
- **Library & sidebar-recents rows:** drop the "Done" pill (status by exception —
  show a small `--amber` dot only while *processing*). Right side = ONE muted line:
  time `·` platform (a quiet line icon + `--text-faint`); move duration to the detail.
  Title prominent; metadata recedes; consistent row rhythm.
- **Meeting detail:** Export → a single `Export ▾` menu (not 7 pills); drop the
  "STATUS Done" stat; action-item owners as muted inline text ("— Devon"), not pills;
  collapse the PLATFORM/STATUS/DURATION trio into one muted line.
- **Date filters:** tokenize or replace the native date control so no `mm/dd/yyyy`
  default chrome shows.
- **Accent map (the only places `--accent` may appear):** active nav pill · primary
  button · "You" speaker label/bubble · a positive status dot. Audit & remove any
  other accent use.

---

## 13. macOS-skill compliance (PRD-16)

We ran the generic [macos-design-skill](https://github.com/ceorkm/macos-design-skill)
checklist against Loqui. **This document and its ref-1/ref-2 derivation win where
they conflict with the generic skill** — Loqui's brief is the *editorial warm*
aesthetic, not stock macOS neutral. Below is what we adopt and what we
intentionally diverge on.

### 13.1 Adopted (genuine, non-conflicting improvements)
- **Keyboard-first.** Primary actions have macOS-correct shortcuts wired in the
  shell, with the platform-correct modifier (⌘ on macOS / Ctrl elsewhere,
  detected at runtime — `renderer/shortcuts/platform.ts`):
  - **Navigate:** `⌘1` Home · `⌘2` Meeting · `⌘3` Library · `⌘,` Settings.
  - `⌘N` start a meeting · `⌘F` focus the Library search · `Esc` backs out of an
    open meeting detail (the export menu + inline rename keep their own local
    Esc) · `⌘⏎` send the chat message (alongside plain Enter).
  - Implemented as a single document-level handler (`useKeyboardShortcuts`) that
    **respects input focus** — plain keys never hijack typing; modifier combos
    and Esc still fire from a field (the ⌘F-while-typing convention). Unit-tested.
- **Visible `<kbd>` hints** (§9.12) — faint tokenized chips where natural: `⌘F`
  in the search field, `⌘N` on Start meeting, `⌘⏎` in the composer.
- **Vibrancy + edge definition** (§6) — 180% saturate + the 0.5px `--glass-edge`
  ring on glass surfaces/cards.
- **UI disclosure** (§9.11) — the Library hides its search + date controls until
  meetings exist and shows a calm empty state; recording controls already
  disclose by phase; row metadata recedes (§12).
- **Contextual controls** — actions live where the content is (per-meeting Export
  menu, in-context composer), not in a global toolbar.

### 13.2 Intentionally diverged (the references override the generic skill)
- **(a) Generous radii.** Skill says cards `8px` / windows `10px`. We use
  `--radius-lg 18` – `--radius-xl 24` (composer `--radius-2xl 28`) per §4 —
  ref-1/ref-2 are unmistakably soft and anti-boxy. Small 8px radii would read as
  generic web chrome.
- **(b) Warm-paper palette.** Skill specifies neutral `#FFFFFF` / `#F5F5F7` /
  `#1D1D1F` + system blue `#007AFF`. We use the warm paper canvas (`--bg #FBF8F3`),
  warm inks, and a single **muted sage** accent (§1) — pure white/neutral-grey
  and system blue are explicitly on the §0 "never" list. (We still honour the
  skill's *materials* guidance — vibrancy, hairline ring — just in warm tokens.)
- **(c) Editorial / generous spacing.** Skill prescribes a tight 8px grid with
  `12–16px` gaps and `16–24px` padding. We keep a 4px *base* but compose with
  generous editorial rhythm — card padding 24, `≥ 24px` between blocks, `32–40px`
  below a page title, a centered `--content-max` column (§3). Negative space is a
  feature; tight density would fight the editorial north star (§0).

Reason: ref-1 (warm editorial AI-assistant) and ref-2 (calm sage dashboard) are
the design brief; the generic skill is a baseline. We take its
keyboard/material/disclosure rigor and keep our warm, editorial, generously-spaced
identity.
