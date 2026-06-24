/**
 * mcp-server TOOL + TRANSPORT tests (PRD-7).
 *
 * Drives the real MCP server over an in-memory client<->server transport pair
 * (no stdio/socket needed) against a SEEDED read-only store, asserting each of
 * the 5 tools end-to-end through the protocol: list (date order + range),
 * search (transcript AND summary, with snippet), get_meeting / get_transcript
 * (live|diarized) / get_summary. Plus the READ-ONLY surface assertion (exactly
 * MCP_TOOL_NAMES, every tool readOnlyHint, no mutator tool) and a stdio transport
 * smoke (createMcpServer stdio start/stop).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MCP_TOOL_NAMES,
  type DiarizedTranscript,
  type Summary,
} from "@loqui/shared";
import {
  buildLoquiMcpServer,
  createMcpServer,
  createReadStore,
} from "../src/server.js";
import { makeMeeting, seedStore, type SeededStore } from "./seed.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const T_A = "2026-06-01T10:00:00.000Z";
const T_B = "2026-06-10T10:00:00.000Z";
const T_C = "2026-06-20T10:00:00.000Z";

function seedThree(): SeededStore {
  const summaryC: Summary = {
    meetingId: ID_C,
    version: 1,
    tldr: "We agreed to ship the kraken release on Friday.",
    decisions: ["Ship Friday"],
    actionItems: [{ text: "Cut the release branch", owner: "Ada" }],
    topics: ["release"],
    provider: "fake",
    model: "test",
    generatedAt: T_C,
  };
  const diarizedB: DiarizedTranscript = {
    meetingId: ID_B,
    version: 1,
    diarized: true,
    backend: "fake",
    speakers: ["Speaker 1"],
    segments: [
      { segId: "s1", source: "system", text: "The platypus budget is approved.", tStart: 0, tEnd: 2, speaker: "Speaker 1", displayName: null },
    ],
  };
  return seedStore([
    {
      meeting: makeMeeting({ id: ID_A, title: "Standup", platform: "zoom", createdAt: T_A, startedAt: T_A }),
      liveTranscript: "Alpha standup notes about the widget.\n",
      ftsTranscript: "Alpha standup notes about the widget.",
    },
    {
      meeting: makeMeeting({ id: ID_B, title: "Design review", createdAt: T_B }),
      liveTranscript: "Live raw transcript for design review.\n",
      diarizedTranscriptMd: "## Diarized\n\n**Speaker 1:** The platypus budget is approved.\n",
      diarizedTranscriptJson: diarizedB,
      ftsTranscript: "The platypus budget is approved.",
    },
    {
      meeting: makeMeeting({ id: ID_C, title: "Planning", platform: "google-meet", createdAt: T_C, startedAt: T_C }),
      liveTranscript: "Planning live transcript.\n",
      ftsSummary: "We agreed to ship the kraken release on Friday.",
      summary: summaryC,
    },
  ]);
}

let seeded: SeededStore;
let client: Client;
let serverClose: () => Promise<void>;

/** Wire a real Client to a server built over the seeded read store. */
async function connectClient(): Promise<void> {
  const store = createReadStore(seeded.dataRoot);
  const server = buildLoquiMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  serverClose = async () => {
    await server.close();
    store.close();
  };
}

/** Pull the structured payload out of a callTool result. */
function structured<T>(res: { structuredContent?: unknown }): T {
  return res.structuredContent as T;
}

beforeEach(async () => {
  seeded = seedThree();
  await connectClient();
});
afterEach(async () => {
  await client.close();
  await serverClose();
  seeded.cleanup();
});

describe("tool surface — STRICTLY READ-ONLY", () => {
  it("exposes EXACTLY the 5 read-only tools, all readOnlyHint", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(5);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      // Every name is a read verb (get/list/search) — no write/edit/delete tool.
      expect(t.name).toMatch(/^(list|search|get)_/);
    }
  });

  it("calling a non-existent write tool fails (no such tool registered)", async () => {
    // Unknown tools come back as a tool-error result (the SDK surfaces invalid
    // calls as isError rather than a thrown rejection). Either way there is NO
    // such tool, which is the read-only point.
    const res = (await client.callTool({
      name: "delete_meeting",
      arguments: { id: ID_A },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });
});

describe("list_meetings tool", () => {
  it("returns meetings newest-first as compact refs", async () => {
    const res = await client.callTool({ name: "list_meetings", arguments: {} });
    const out = structured<{ meetings: { id: string; title: string; createdAt: string }[] }>(res);
    expect(out.meetings.map((m) => m.id)).toEqual([ID_C, ID_B, ID_A]);
    expect(out.meetings[0]).toMatchObject({ id: ID_C, title: "Planning" });
    expect(out.meetings[0]?.createdAt).toBe(T_C);
  });

  it("filters by date range", async () => {
    const res = await client.callTool({ name: "list_meetings", arguments: { from: T_B, to: T_C } });
    const out = structured<{ meetings: { id: string }[] }>(res);
    expect(out.meetings.map((m) => m.id)).toEqual([ID_C, ID_B]);
  });
});

describe("search_meetings tool", () => {
  it("finds a keyword in a TRANSCRIPT with a snippet + meeting ref", async () => {
    const res = await client.callTool({ name: "search_meetings", arguments: { query: "platypus" } });
    const out = structured<{ hits: { meeting: { id: string }; snippet: string }[] }>(res);
    expect(out.hits.map((h) => h.meeting.id)).toEqual([ID_B]);
    expect(out.hits[0]?.snippet).toContain("platypus");
  });

  it("finds a keyword in a SUMMARY with a highlighted summary snippet", async () => {
    const res = await client.callTool({ name: "search_meetings", arguments: { query: "kraken" } });
    const out = structured<{ hits: { meeting: { id: string }; snippet: string }[] }>(res);
    expect(out.hits.map((h) => h.meeting.id)).toEqual([ID_C]);
    // Summary-only hit: the snippet falls back to the summary column so it cites
    // the match instead of returning unrelated/empty transcript text.
    expect(out.hits[0]?.snippet).toContain("kraken");
    expect(out.hits[0]?.snippet).toContain("[");
  });

  it("rejects an empty query (min(1) input schema)", async () => {
    // The tight input schema (query.min(1)) makes the server reject an empty
    // query with a validation tool-error result rather than running a search.
    const res = (await client.callTool({
      name: "search_meetings",
      arguments: { query: "" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });
});

describe("get_meeting tool", () => {
  it("returns full metadata for a known id, null for unknown", async () => {
    const res = await client.callTool({ name: "get_meeting", arguments: { id: ID_C } });
    const out = structured<{ meeting: { id: string; platform: string; status: string } | null }>(res);
    expect(out.meeting?.id).toBe(ID_C);
    expect(out.meeting?.platform).toBe("google-meet");

    const miss = await client.callTool({
      name: "get_meeting",
      arguments: { id: "99999999-9999-4999-8999-999999999999" },
    });
    expect(structured<{ meeting: unknown }>(miss).meeting).toBeNull();
  });
});

describe("get_transcript tool", () => {
  it("defaults to diarized (returns diarized md when present)", async () => {
    const res = await client.callTool({ name: "get_transcript", arguments: { id: ID_B } });
    const out = structured<{ id: string; variant: string; text: string }>(res);
    expect(out.variant).toBe("diarized");
    expect(out.text).toContain("**Speaker 1:**");
  });

  it("variant 'live' returns the raw transcript", async () => {
    const res = await client.callTool({ name: "get_transcript", arguments: { id: ID_B, variant: "live" } });
    const out = structured<{ variant: string; text: string }>(res);
    expect(out.variant).toBe("live");
    expect(out.text).toContain("Live raw transcript");
  });

  it("diarized falls back to live when no diarized file", async () => {
    const res = await client.callTool({ name: "get_transcript", arguments: { id: ID_C, variant: "diarized" } });
    expect(structured<{ text: string }>(res).text).toContain("Planning live transcript");
  });

  it("empty text for a meeting/id with no transcript", async () => {
    const res = await client.callTool({
      name: "get_transcript",
      arguments: { id: "99999999-9999-4999-8999-999999999999", variant: "live" },
    });
    expect(structured<{ text: string }>(res).text).toBe("");
  });
});

describe("get_summary tool", () => {
  it("returns the structured summary, null when none", async () => {
    const res = await client.callTool({ name: "get_summary", arguments: { id: ID_C } });
    const out = structured<{ summary: { tldr: string; actionItems: { owner: string | null }[] } | null }>(res);
    expect(out.summary?.tldr).toContain("kraken");
    expect(out.summary?.actionItems[0]?.owner).toBe("Ada");

    const none = await client.callTool({ name: "get_summary", arguments: { id: ID_A } });
    expect(structured<{ summary: unknown }>(none).summary).toBeNull();
  });
});

describe("transport smoke (createMcpServer)", () => {
  it("stdio starts and stops cleanly (idempotent)", async () => {
    // Point the server at the seeded root; default transport is stdio.
    const handle = await createMcpServer({ dataRoot: seeded.dataRoot });
    expect(handle.transport).toBe("stdio");
    expect(handle.url).toBeNull();
    await handle.stop();
    await handle.stop(); // idempotent
  });

  it("http binds LOOPBACK only (127.0.0.1) on an OS-assigned port", async () => {
    const handle = await createMcpServer({
      transport: "http",
      dataRoot: seeded.dataRoot,
      httpPort: 0,
    });
    try {
      expect(handle.transport).toBe("http");
      expect(handle.url).not.toBeNull();
      // Never a public/0.0.0.0 bind — strictly loopback.
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    } finally {
      await handle.stop();
      await handle.stop(); // idempotent
    }
  });
});
