/**
 * Icon — the single shared line-icon set for the whole renderer (DESIGN-SYSTEM
 * §8). Original, geometric, inline-SVG glyphs: stroke 1.5, `currentColor`, NO
 * fill, a 24×24 viewBox, round caps/joins. They inherit colour from the text
 * context and are sized via the `size` prop (default 18px) so a caller never
 * hard-codes dimensions.
 *
 * This component REPLACES every emoji/multicolour glyph in the renderer — the
 * cardinal rule of the rehaul: no emoji, no icon fonts, no filled/coloured
 * glyphs anywhere. Need a new icon? Add it to ICONS below (same stroke recipe)
 * rather than inlining an SVG in a feature component.
 */
import type { JSX, SVGProps } from "react";

/** The v1 icon set (DESIGN-SYSTEM §8). */
export type IconName =
  | "home"
  | "calendar"
  | "library"
  | "mic"
  | "message"
  | "search"
  | "settings"
  | "plus"
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "sidebar"
  | "clock"
  | "user"
  | "users"
  | "link"
  | "sparkle"
  | "check"
  | "check-circle"
  | "x-circle"
  | "dot"
  | "stop"
  | "play"
  | "pause"
  | "x"
  | "download"
  | "share"
  | "lock"
  | "refresh"
  | "file"
  | "video"
  | "arrow-up"
  | "arrow-down";

/**
 * Each icon's path data, drawn on a 24×24 grid, optically centered. Paths are
 * stroked (no fill) via the shared attributes below.
 */
const ICONS: Record<IconName, JSX.Element> = {
  home: (
    <>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9.5h12V10" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="3" />
      <path d="M4 9.5h16M8 3.5v3.5M16 3.5v3.5" />
    </>
  ),
  library: (
    <>
      <path d="M5 4.5h4v15H5zM9 4.5h4v15H9z" />
      <path d="m14 5.4 3.7 1 2.7 13.2-3.7-1z" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  message: (
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5V17H5A1.5 1.5 0 0 1 3.5 15.5V7A1.5 1.5 0 0 1 5 5.5Z" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  "chevron-down": <path d="m6 9.5 6 6 6-6" />,
  "chevron-right": <path d="m9.5 6 6 6-6 6" />,
  "chevron-left": <path d="m14.5 6-6 6 6 6" />,
  sidebar: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="3" />
      <path d="M9.5 5v14" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M16.5 16.2a5.5 5.5 0 0 1 4 3.3" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7.5" />
      <path d="M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 0 0 5 5L13 16.5" />
    </>
  ),
  sparkle: (
    <path d="M12 4c.4 3.4 1.8 4.8 5.2 5.2-3.4.4-4.8 1.8-5.2 5.2-.4-3.4-1.8-4.8-5.2-5.2C10.2 8.8 11.6 7.4 12 4Z" />
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
    </>
  ),
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />,
  play: <path d="M8 5.5 18 12 8 18.5z" />,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  download: (
    <>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 19h14" />
    </>
  ),
  share: (
    <>
      <path d="M12 15V4M8 7.5 12 3.5 16 7.5" />
      <path d="M6 12.5V18a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 18v-5.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M19 11a7 7 0 0 0-12-4.2L4.5 9" />
      <path d="M5 13a7 7 0 0 0 12 4.2L19.5 15" />
      <path d="M4.5 4.5V9H9M19.5 19.5V15H15" />
    </>
  ),
  file: (
    <>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" />
      <path d="M13.5 3.5V8h4" />
    </>
  ),
  video: (
    <>
      <rect x="3.5" y="6.5" width="12" height="11" rx="2.5" />
      <path d="m15.5 10.5 5-2.5v8l-5-2.5z" />
    </>
  ),
  "arrow-up": <path d="M12 19V5M6 11l6-6 6 6" />,
  "arrow-down": <path d="M12 5v14M6 13l6 6 6-6" />,
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  /** Which glyph from the v1 set to render. */
  name: IconName;
  /** Rendered edge length in px (default 18). Width === height. */
  size?: number;
}

/**
 * Render a line icon from the shared set. Decorative by default
 * (`aria-hidden`); pass an `aria-label` (and the caller sets `role="img"`) for
 * a meaningful standalone icon.
 */
export function Icon({ name, size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={rest["aria-label"] ? undefined : true}
      focusable="false"
      {...rest}
    >
      {ICONS[name]}
    </svg>
  );
}
