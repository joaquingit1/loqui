import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@loqui/shared";
import { SidecarClient, type RawSocket } from "./client.js";

type JsonSchema = Record<string, unknown>;

/**
 * Load the EMITTED WsEnvelope JSON Schema (the same file the Python sidecar
 * validates against) and return a predicate. We resolve it through @loqui/shared
 * so the test fails loudly if the contract drifts. A tiny draft-07 subset
 * validator covers exactly what this schema uses: anyOf of flat objects with
 * properties / required / additionalProperties:false / const / enum / minLength.
 */
async function loadWsEnvelopeValidator(): Promise<(v: unknown) => boolean> {
  const require = createRequire(import.meta.url);
  const schemaPath = require.resolve("@loqui/shared/schema/WsEnvelope.json");
  const root = JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;
  const defs = (root.definitions ?? {}) as Record<string, JsonSchema>;
  const top = defs.WsEnvelope as JsonSchema;
  const branches = (top.anyOf ?? []) as JsonSchema[];

  const matchesNode = (schema: JsonSchema, value: unknown): boolean => {
    if (Array.isArray(schema.anyOf)) {
      return (schema.anyOf as JsonSchema[]).some((s) => matchesNode(s, value));
    }
    const type = schema.type as string | undefined;
    if (type === "null") return value === null;
    if (type === "string") {
      if (typeof value !== "string") return false;
      if (typeof schema.const === "string" && value !== schema.const) return false;
      if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) return false;
      if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
      return true;
    }
    if (type === "boolean") {
      if (typeof value !== "boolean") return false;
      if (typeof schema.const === "boolean" && value !== schema.const) return false;
      return true;
    }
    if (type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = (schema.required ?? []) as string[];
      for (const key of required) {
        if (!(key in obj)) return false;
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) return false;
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj && Object.keys(sub).length > 0 && !matchesNode(sub, obj[key])) {
          return false;
        }
      }
      return true;
    }
    // No `type` constraint (e.g. {} for params/result/data): accept anything.
    return true;
  };

  return (value: unknown) => branches.some((b) => matchesNode(b, value));
}

class FakeSocket extends EventEmitter implements RawSocket {
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
  /** Push a server frame to the client. */
  push(obj: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(obj), "utf8"));
  }
  lastId(): string {
    return (JSON.parse(this.sent[this.sent.length - 1]!) as { id: string }).id;
  }
}

describe("SidecarClient request correlation", () => {
  it("resolves a request when the matching response arrives", async () => {
    const socket = new FakeSocket();
    const client = new SidecarClient(socket, { token: "t" });
    const p = client.getHealth();
    const id = socket.lastId();
    socket.push({
      type: "response",
      id,
      ok: true,
      result: { status: "ok", version: "9", protocolVersion: PROTOCOL_VERSION, models: {} },
    });
    const health = await p;
    expect(health.version).toBe("9");
  });

  it("sends a contract-shaped request envelope without a token field", async () => {
    const socket = new FakeSocket();
    const client = new SidecarClient(socket, { token: "sekret" });
    void client.ping();
    const env = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    // The connection is already token-authed; the sidecar validates frames
    // against WsEnvelope (additionalProperties:false), so a `token` key would
    // be rejected as an invalid frame. The envelope must be {type,id,method}.
    expect(env.type).toBe("request");
    expect(env.method).toBe("ping");
    expect(typeof env.id).toBe("string");
    expect("token" in env).toBe(false);
    expect(Object.keys(env).sort()).toEqual(["id", "method", "type"]);
  });

  it("produces an envelope that validates against the emitted WsEnvelope JSON Schema (additionalProperties:false)", async () => {
    // Guard against re-introducing the token: the sidecar validates inbound
    // frames against the EMITTED JSON Schema (whose request branch is
    // additionalProperties:false), not against the lenient zod runtime. Load
    // that schema and validate the EXACT envelope the client sends.
    const socket = new FakeSocket();
    const client = new SidecarClient(socket, { token: "sekret" });
    void client.ping();
    const env = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    const validate = await loadWsEnvelopeValidator();
    expect(validate(env)).toBe(true);
    // A token-bearing variant must be rejected by the strict request branch —
    // this is the production bug the prior test enshrined.
    expect(validate({ ...env, token: "sekret" })).toBe(false);
  });

  it("rejects on an error frame for the matching id", async () => {
    const socket = new FakeSocket();
    const client = new SidecarClient(socket, { token: "t" });
    const p = client.request("getHealth");
    const id = socket.lastId();
    socket.push({ type: "error", id, ok: false, error: { code: "boom", message: "bad" } });
    await expect(p).rejects.toThrow(/boom: bad/);
  });

  it("ignores responses with an unknown id", async () => {
    const socket = new FakeSocket();
    const client = new SidecarClient(socket, { token: "t" });
    const p = client.ping();
    const id = socket.lastId();
    socket.push({ type: "response", id: "not-the-id", ok: true, result: { pong: true } });
    socket.push({ type: "response", id, ok: true, result: { pong: true, ts: 1 } });
    expect((await p).ok).toBe(true);
  });

  it("times out a request that never gets a response", async () => {
    const socket = new FakeSocket();
    const client = new SidecarClient(socket, { token: "t", requestTimeoutMs: 10 });
    await expect(client.request("ping")).rejects.toThrow(/timed out/);
  });

  it("ping resolves ok:false on timeout instead of throwing", async () => {
    const socket = new FakeSocket();
    const client = new SidecarClient(socket, { token: "t", requestTimeoutMs: 10 });
    const r = await client.ping();
    expect(r.ok).toBe(false);
  });

  it("routes notifications to the onNotification callback", () => {
    const socket = new FakeSocket();
    const onNotification = vi.fn();
    new SidecarClient(socket, { token: "t", onNotification });
    socket.push({ type: "notification", event: "jobUpdate", data: { jobId: "j1" } });
    expect(onNotification).toHaveBeenCalledWith("jobUpdate", { jobId: "j1" });
  });

  it("rejects in-flight requests and notifies onClose when the socket closes", async () => {
    const socket = new FakeSocket();
    const onClose = vi.fn();
    const client = new SidecarClient(socket, { token: "t", onClose });
    const p = client.request("getHealth");
    socket.emit("close");
    await expect(p).rejects.toThrow(/connection lost/);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("measures latency with an injected clock", async () => {
    const socket = new FakeSocket();
    let t = 1000;
    const client = new SidecarClient(socket, { token: "t", now: () => t });
    const p = client.ping();
    const id = socket.lastId();
    t = 1075;
    socket.push({ type: "response", id, ok: true, result: { pong: true, ts: 0 } });
    const r = await p;
    expect(r.latencyMs).toBe(75);
  });
});
