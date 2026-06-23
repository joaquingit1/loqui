import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@loqui/shared";
import { extractFirstLine, parseHandshakeLine } from "./handshake.js";

describe("extractFirstLine", () => {
  it("returns null line until a newline arrives", () => {
    expect(extractFirstLine("partial json no newline")).toEqual({
      line: null,
      rest: "partial json no newline",
    });
  });

  it("extracts the first line and keeps the rest", () => {
    expect(extractFirstLine('{"a":1}\nleftover')).toEqual({
      line: '{"a":1}',
      rest: "leftover",
    });
  });

  it("strips a trailing CR (CRLF line endings)", () => {
    expect(extractFirstLine('{"a":1}\r\nrest')).toEqual({
      line: '{"a":1}',
      rest: "rest",
    });
  });

  it("handles an empty first line", () => {
    expect(extractFirstLine("\nrest")).toEqual({ line: "", rest: "rest" });
  });

  it("only consumes the first of multiple lines", () => {
    const out = extractFirstLine("one\ntwo\nthree");
    expect(out.line).toBe("one");
    expect(out.rest).toBe("two\nthree");
  });
});

function goodLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    port: 51234,
    token: "secret-token",
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  });
}

describe("parseHandshakeLine", () => {
  it("accepts a valid handshake line", () => {
    const r = parseHandshakeLine(goodLine());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.handshake.port).toBe(51234);
      expect(r.handshake.token).toBe("secret-token");
      expect(r.handshake.protocolVersion).toBe(PROTOCOL_VERSION);
    }
  });

  it("tolerates surrounding whitespace", () => {
    const r = parseHandshakeLine(`   ${goodLine()}   `);
    expect(r.ok).toBe(true);
  });

  it("rejects an empty line", () => {
    const r = parseHandshakeLine("   ");
    expect(r).toMatchObject({ ok: false, code: "EMPTY_LINE" });
  });

  it("rejects non-JSON", () => {
    const r = parseHandshakeLine("not json at all");
    expect(r).toMatchObject({ ok: false, code: "INVALID_JSON" });
  });

  it("rejects a port that is not a positive integer", () => {
    expect(parseHandshakeLine(goodLine({ port: 0 }))).toMatchObject({
      ok: false,
      code: "SCHEMA_INVALID",
    });
    expect(parseHandshakeLine(goodLine({ port: -5 }))).toMatchObject({
      ok: false,
      code: "SCHEMA_INVALID",
    });
    expect(parseHandshakeLine(goodLine({ port: 1.5 }))).toMatchObject({
      ok: false,
      code: "SCHEMA_INVALID",
    });
  });

  it("rejects an empty token", () => {
    expect(parseHandshakeLine(goodLine({ token: "" }))).toMatchObject({
      ok: false,
      code: "SCHEMA_INVALID",
    });
  });

  it("rejects a missing field", () => {
    const r = parseHandshakeLine(JSON.stringify({ port: 5, token: "t" }));
    expect(r).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
  });

  it("fails LOUDLY on a protocol version mismatch", () => {
    const r = parseHandshakeLine(goodLine({ protocolVersion: "9.9.9" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PROTOCOL_VERSION_MISMATCH");
      expect(r.message).toContain(PROTOCOL_VERSION);
      expect(r.message).toContain("9.9.9");
    }
  });
});
