/**
 * MeetingView — thin wrapper that opens one meeting (loaded by id from the
 * Library/recents) and renders it through the shared {@link MeetingDoc}, the ONE
 * finished-meeting surface used everywhere (a just-finished meeting renders the
 * exact same component). Kept as a named export so the Library + App import
 * sites + tests have a stable entry point.
 *
 * READ-ONLY over the transcript (the AI never edits it) — see {@link MeetingDoc}.
 */
import { type JSX } from "react";
import type { Meeting } from "@loqui/shared";
import type {
  LoquiChatApi,
  LoquiExportApi,
  LoquiLibraryApi,
} from "../../preload/index.js";
import { MeetingDoc } from "./MeetingDoc.js";

export interface MeetingViewProps {
  /** The meeting to display. */
  meeting: Meeting;
  /** Library bridge (subset). Injectable for tests; defaults to window.loqui.library. */
  api?: Pick<LoquiLibraryApi, "getTranscript" | "renameMeeting">;
  /** Export bridge (PRD-13). Injectable for tests; defaults to window.loqui.export. */
  exportApi?: Pick<LoquiExportApi, "exportMeeting">;
  /** Chat bridge (PRD-4). Injectable for tests; defaults to window.loqui.chat. */
  chatApi?: LoquiChatApi;
  /** Navigate back to the Library list. */
  onBack?: () => void;
  /** Fired with the updated Meeting after a successful rename. */
  onRenamed?: (meeting: Meeting) => void;
}

export function MeetingView(props: MeetingViewProps): JSX.Element {
  return <MeetingDoc {...props} />;
}
