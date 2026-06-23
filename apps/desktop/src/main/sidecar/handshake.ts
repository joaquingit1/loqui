/**
 * Parsing + validation of the sidecar's single stdout handshake line.
 *
 * The sidecar prints exactly ONE line of JSON to stdout BEFORE it begins
 * serving: `{"port":<n>,"token":"<random>","protocolVersion":"<v>"}`. The main
 * process reads that line, parses it, validates it against the shared
 * `handshakeSchema`, and refuses to connect on a PROTOCOL_VERSION mismatch.
 *
 * This module is pure: it never spawns or reads from a process. It is fed raw
 * text (a chunk or an accumulated buffer) and returns a typed result, so it is
 * trivially unit-testable without a child process.
 */
import { PROTOCOL_VERSION, handshakeSchema, type Handshake } from "@loqui/shared";

/** A line was extracted from a buffer of stdout text. */
export interface LineExtraction {
  /** The first complete line (without its trailing newline), or null if none yet. */
  line: string | null;
  /** The buffer remaining after the extracted line (everything past the `\n`). */
  rest: string;
}

/**
 * Extract the first complete newline-terminated line from `buffer`. Handles
 * both `\n` and `\r\n`. Returns `{ line: null, rest: buffer }` when no full
 * line has arrived yet (so the caller keeps accumulating).
 */
export function extractFirstLine(buffer: string): LineExtraction {
  const nl = buffer.indexOf("\n");
  if (nl === -1) return { line: null, rest: buffer };
  let line = buffer.slice(0, nl);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  const rest = buffer.slice(nl + 1);
  return { line, rest };
}

export type HandshakeParse =
  | { ok: true; handshake: Handshake }
  | { ok: false; code: HandshakeErrorCode; message: string };

export type HandshakeErrorCode =
  | "EMPTY_LINE"
  | "INVALID_JSON"
  | "SCHEMA_INVALID"
  | "PROTOCOL_VERSION_MISMATCH";

/**
 * Parse and fully validate a single handshake line.
 *
 * Order of checks:
 *   1. non-empty,
 *   2. valid JSON,
 *   3. matches `handshakeSchema` (port int>0, token non-empty, protocolVersion string),
 *   4. protocolVersion === PROTOCOL_VERSION (fails LOUDLY on mismatch).
 */
export function parseHandshakeLine(line: string): HandshakeParse {
  const trimmed = line.trim();
  if (trimmed === "") {
    return { ok: false, code: "EMPTY_LINE", message: "handshake line was empty" };
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      code: "INVALID_JSON",
      message: `handshake line is not valid JSON: ${(err as Error).message}`,
    };
  }

  const parsed = handshakeSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      message: `handshake failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }

  if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "PROTOCOL_VERSION_MISMATCH",
      message:
        `sidecar PROTOCOL_VERSION mismatch: main expects "${PROTOCOL_VERSION}", ` +
        `sidecar reported "${parsed.data.protocolVersion}"`,
    };
  }

  return { ok: true, handshake: parsed.data };
}
