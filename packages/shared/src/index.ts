/**
 * @loqui/shared — the single source of truth for cross-process contracts.
 *
 * Consumed by:
 *   - apps/desktop (Electron main + preload + renderer), TS imports.
 *   - mcp-server (TS imports).
 *   - sidecar (Python), via the JSON Schemas emitted to ./schema/*.json.
 */
export * from "./constants.js";
export * from "./protocol.js";
export * from "./meeting.js";
export * from "./audio.js";
export * from "./audio-bridge.js";
export * from "./events.js";
export * from "./transcript.js";
export * from "./library.js";
export * from "./chat.js";
export * from "./postprocess.js";
export * from "./store-read.js";
export * from "./mcp.js";
export * from "./calendar.js";
