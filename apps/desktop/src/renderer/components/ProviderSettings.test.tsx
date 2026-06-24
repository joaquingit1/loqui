/**
 * ProviderSettings tests (jsdom). HERMETIC: the LoquiChatApi is injected as a
 * controllable fake. Covers: provider switching reveals per-provider fields,
 * Save persists settings, the API key is sent to the secure-store bridge and is
 * NEVER rendered back (no plaintext echo), the key field reports stored/not-
 * stored status, and clearing the key calls setApiKey(null).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiKeyStatus, ProviderConfig, SetApiKeyParams } from "@loqui/shared";
import { ProviderSettings } from "./ProviderSettings.js";
import type { LoquiChatApi } from "../../preload/index.js";

afterEach(cleanup);

const ANTHROPIC_CONFIG: ProviderConfig = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  baseUrl: "http://localhost:11434",
  ollamaModel: "llama3.1",
  cli: "claude",
};

type SettingsApi = Pick<
  LoquiChatApi,
  "getProviderSettings" | "setProviderSettings" | "setApiKey" | "getApiKeyStatus"
>;

function makeApi(
  overrides: Partial<SettingsApi> = {},
  config = ANTHROPIC_CONFIG,
): { api: SettingsApi; setApiKey: ReturnType<typeof vi.fn> } {
  const setApiKey = vi.fn(
    async (p: SetApiKeyParams): Promise<ApiKeyStatus> => ({
      provider: p.provider,
      hasKey: Boolean(p.apiKey),
    }),
  );
  const api: SettingsApi = {
    getProviderSettings: vi.fn(async () => config),
    setProviderSettings: vi.fn(async (c: ProviderConfig) => c),
    setApiKey,
    getApiKeyStatus: vi.fn(
      async (): Promise<ApiKeyStatus> => ({ provider: "anthropic", hasKey: false }),
    ),
    ...overrides,
  };
  return { api, setApiKey: api.setApiKey as ReturnType<typeof vi.fn> };
}

describe("ProviderSettings", () => {
  it("loads the persisted provider config and shows the Anthropic model picker", async () => {
    const { api } = makeApi();
    render(<ProviderSettings api={api} />);
    await waitFor(() =>
      expect((screen.getByTestId("provider-select") as HTMLSelectElement).value).toBe("anthropic"),
    );
    expect(screen.getByTestId("anthropic-model-select")).toBeTruthy();
    expect((screen.getByTestId("anthropic-model-select") as HTMLSelectElement).value).toBe(
      "claude-opus-4-8",
    );
  });

  it("reveals Ollama base URL + model fields when Ollama is selected", async () => {
    const { api } = makeApi();
    render(<ProviderSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("provider-select")).toBeTruthy());

    fireEvent.change(screen.getByTestId("provider-select"), { target: { value: "ollama" } });
    expect(screen.getByTestId("ollama-base-url")).toBeTruthy();
    expect(screen.getByTestId("ollama-model")).toBeTruthy();
    // The Anthropic key field is gone for a non-key provider.
    expect(screen.queryByTestId("api-key-field")).toBeNull();
  });

  it("reveals the agent-CLI picker when the local-agent provider is selected", async () => {
    const { api } = makeApi();
    render(<ProviderSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("provider-select")).toBeTruthy());

    fireEvent.change(screen.getByTestId("provider-select"), { target: { value: "agent-cli" } });
    expect(screen.getByTestId("agent-cli-select")).toBeTruthy();
  });

  it("sends the API key to the secure-store bridge and never echoes it back", async () => {
    const { api, setApiKey } = makeApi();
    const onSaved = vi.fn();
    render(<ProviderSettings api={api} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByTestId("api-key-input")).toBeTruthy());

    const SECRET = "sk-ant-super-secret-123";
    const input = screen.getByTestId("api-key-input") as HTMLInputElement;
    // Stored in a password field (masked).
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: SECRET } });

    fireEvent.click(screen.getByTestId("provider-save"));

    await waitFor(() => expect(setApiKey).toHaveBeenCalled());
    expect(setApiKey).toHaveBeenCalledWith({ provider: "anthropic", apiKey: SECRET });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    // After saving, the plaintext key is cleared from the input and is NOT
    // rendered anywhere in the settings DOM.
    await waitFor(() =>
      expect((screen.getByTestId("api-key-input") as HTMLInputElement).value).toBe(""),
    );
    expect(screen.getByTestId("provider-settings").textContent).not.toContain(SECRET);
    // The status flips to "Key saved".
    await waitFor(() =>
      expect(screen.getByTestId("api-key-status").getAttribute("data-has-key")).toBe("true"),
    );
  });

  it("persists the (non-secret) provider settings on Save", async () => {
    const setProviderSettings = vi.fn(async (c: ProviderConfig) => c);
    const { api } = makeApi({ setProviderSettings });
    render(<ProviderSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("provider-select")).toBeTruthy());

    fireEvent.change(screen.getByTestId("anthropic-model-select"), {
      target: { value: "claude-sonnet-4-6" },
    });
    fireEvent.click(screen.getByTestId("provider-save"));

    await waitFor(() => expect(setProviderSettings).toHaveBeenCalled());
    expect(setProviderSettings.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("does not call setApiKey when no key was typed", async () => {
    const { api, setApiKey } = makeApi();
    render(<ProviderSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("provider-save")).toBeTruthy());

    fireEvent.click(screen.getByTestId("provider-save"));
    await waitFor(() => expect(api.setProviderSettings).toHaveBeenCalled());
    expect(setApiKey).not.toHaveBeenCalled();
  });

  it("shows 'Key saved' and a Clear control when a key is already stored", async () => {
    const { api, setApiKey } = makeApi({
      getApiKeyStatus: vi.fn(
        async (): Promise<ApiKeyStatus> => ({ provider: "anthropic", hasKey: true }),
      ),
    });
    render(<ProviderSettings api={api} />);

    await waitFor(() =>
      expect(screen.getByTestId("api-key-status").getAttribute("data-has-key")).toBe("true"),
    );
    expect(screen.getByTestId("api-key-status").textContent).toContain("Key saved");

    fireEvent.click(screen.getByTestId("api-key-clear"));
    await waitFor(() => expect(setApiKey).toHaveBeenCalledWith({ provider: "anthropic", apiKey: null }));
    await waitFor(() =>
      expect(screen.getByTestId("api-key-status").getAttribute("data-has-key")).toBe("false"),
    );
  });
});
