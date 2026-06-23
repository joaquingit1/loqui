/**
 * @file Renderer-side Library (PRD-3) public surface.
 *
 * Re-exports the pure date-grouping / formatting helpers so the Library +
 * MeetingView components (and tests) import from one place. The React
 * components themselves live under ../components (Library.tsx / MeetingView.tsx)
 * to match the existing renderer layout.
 */
export {
  displayTitle,
  formatDuration,
  formatMeetingTime,
  GROUP_LABEL,
  GROUP_ORDER,
  groupKeyFor,
  groupMeetingsByDate,
  PLATFORM_LABEL,
  platformLabel,
  STATUS_LABEL,
  statusLabel,
  type GroupKey,
  type MeetingGroup,
} from "./grouping.js";
