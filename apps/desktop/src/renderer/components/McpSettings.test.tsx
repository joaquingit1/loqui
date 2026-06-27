/**
 * McpSettings tests (jsdom). HERMETIC: the LoquiMcpApi is injected as a
 * controllable fake. The server runs whenever Loqui is open (no user toggle), so
 * the panel is a read-only indicator + config snippets — there is NO start/stop
 * button. Covers: the panel renders the status indicator + the config snippets +
 * the explainer; a live status push updates the indicator; Copy writes the
 * snippet to the clipboard; and the read-only framing is present (no
 * write/edit/toggle affordance).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { McpConfigSnippet, McpStatus } from "@loqui/shared";
import { McpSettings } from "./McpSettings.js";
import type { LoquiMcpApi } from "../../preload/index.js";

afterEach(cleanup);

const STOPPED: McpStatus = {
  running: false,
  transport: "http",
  url: null,
  dataRoot: "/Users/me/Loqui",
  pid: null,
};
const RUNNING: McpStatus = {
  running: true,
  transport: "http",
  url: "http://127.0.0.1:7333",
  dataRoot: "/Users/me/Loqui",
  pid: 4242,
};

const SNIPPETS: McpConfigSnippet[] = [
  { target: "claude-code", label: "Claude Code", language: "bash", content: "claude mcp add loqui -- loqui-mcp" },
  { target: "claude-desktop", label: "Claude Desktop", language: "json", content: '{"mcpServers":{"loqui":{}}}' },
  { target: "codex", label: "Codex", language: "toml", content: "[mcp_servers.loqui]" },
];

type McpApi = Pick<LoquiMcpApi, "status" | "getConfigSnippets" | "onStatus">;

function makeApi(
  overrides: Partial<McpApi> = {},
  initial: McpStatus = STOPPED,
): { api: McpApi; emitStatus: (s: McpStatus) => void } {
  let cb: ((s: McpStatus) => void) | null = null;
  const api: McpApi = {
    status: vi.fn(async () => initial),
    getConfigSnippets: vi.fn(async () => SNIPPETS),
    onStatus: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    ...overrides,
  };
  return { api, emitStatus: (s) => cb?.(s) };
}

describe("McpSettings", () => {
  it("renders the title, explainer, status, and snippets (no start/stop toggle)", async () => {
    const { api } = makeApi();
    render(<McpSettings api={api} />);

    expect(screen.getByTestId("mcp-settings")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Agent access/i })).toBeTruthy();
    // Explainer mentions always-on + search + read-only + local.
    const panel = screen.getByTestId("mcp-settings");
    expect(panel.textContent).toMatch(/runs whenever Loqui is open/i);
    expect(panel.textContent).toMatch(/search past meetings/i);
    expect(panel.textContent).toMatch(/read-only/i);

    await waitFor(() => expect(screen.getByTestId("mcp-status")).toBeTruthy());
    expect(screen.getByTestId("mcp-status").getAttribute("data-running")).toBe("false");

    // No start/stop toggle: the server is always-on.
    expect(screen.queryByTestId("mcp-toggle")).toBeNull();

    // One snippet block per agent.
    await waitFor(() => expect(screen.getByTestId("mcp-snippet-claude-code")).toBeTruthy());
    expect(screen.getByTestId("mcp-snippet-claude-desktop")).toBeTruthy();
    expect(screen.getByTestId("mcp-snippet-codex")).toBeTruthy();
  });

  it("shows the loopback URL when the server is running", async () => {
    const { api } = makeApi({}, RUNNING);
    render(<McpSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-running")).toBe("true"));
    await waitFor(() => expect(screen.getByTestId("mcp-url").textContent).toContain("127.0.0.1"));
  });

  it("updates the indicator on a live status push", async () => {
    const { api, emitStatus } = makeApi();
    render(<McpSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-running")).toBe("false"));

    act(() => emitStatus(RUNNING));
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-running")).toBe("true"));
  });

  it("shows the served data root", async () => {
    const { api } = makeApi();
    render(<McpSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("mcp-dataroot").textContent).toContain("/Users/me/Loqui"));
  });

  it("copies a snippet to the clipboard on Copy", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { api } = makeApi();
    render(<McpSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("mcp-copy-claude-code")).toBeTruthy());

    fireEvent.click(screen.getByTestId("mcp-copy-claude-code"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("claude mcp add loqui -- loqui-mcp"));
    await waitFor(() => expect(screen.getByTestId("mcp-copy-claude-code").textContent).toContain("Copied"));
  });

  it("surfaces a status-load error instead of throwing", async () => {
    const { api } = makeApi({
      status: vi.fn(async () => {
        throw new Error("bin not found");
      }),
    });
    render(<McpSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("mcp-error").textContent).toContain("bin not found"));
  });

  it("renders without an api (no window.loqui) without throwing", () => {
    expect(() => render(<McpSettings />)).not.toThrow();
    expect(screen.getByTestId("mcp-status").getAttribute("data-running")).toBe("false");
  });

  it("READ-ONLY: the panel offers no write/edit/delete or start/stop affordance", async () => {
    const { api } = makeApi();
    render(<McpSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("mcp-settings")).toBeTruthy());
    // No start/stop toggle — the server is always-on.
    expect(screen.queryByTestId("mcp-toggle")).toBeNull();
    // The only buttons are the per-snippet Copy buttons.
    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    for (const label of buttons) {
      expect(label).not.toMatch(/delete|edit|write|remove meeting|start server|stop server/i);
    }
  });
});
