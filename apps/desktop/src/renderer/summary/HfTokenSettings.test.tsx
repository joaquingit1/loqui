/**
 * HfTokenSettings render/interaction tests (jsdom). HERMETIC: no window.loqui —
 * setHfToken/getHfTokenStatus are injected as controllable fakes.
 *
 * Covers: loads the stored-token status, Save sends the typed token to the
 * bridge (the renderer never persists it elsewhere) + clears the input, the
 * status flips to "saved", Clear sends a null token, and an empty Save is a
 * no-op. SECURITY: the token leaves the renderer only via setHfToken.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  DiarizationBackendStatus,
  HfTokenStatus,
  SetDiarizationBackendParams,
  SetHfTokenParams,
} from "@loqui/shared";
import { HfTokenSettings } from "./HfTokenSettings.js";

afterEach(cleanup);

function makeApi(
  over: Partial<{
    setHfToken: (p: SetHfTokenParams) => Promise<HfTokenStatus>;
    getHfTokenStatus: () => Promise<HfTokenStatus>;
    setDiarizationBackend: (
      p: SetDiarizationBackendParams,
    ) => Promise<DiarizationBackendStatus>;
    getDiarizationBackendStatus: () => Promise<DiarizationBackendStatus>;
  }> = {},
) {
  return {
    setHfToken: vi.fn(async (p: SetHfTokenParams) => ({ hasToken: Boolean(p.token) })),
    getHfTokenStatus: vi.fn(async (): Promise<HfTokenStatus> => ({ hasToken: false })),
    setDiarizationBackend: vi.fn(
      async (p: SetDiarizationBackendParams): Promise<DiarizationBackendStatus> => ({
        diarizationBackend: p.diarizationBackend,
      }),
    ),
    getDiarizationBackendStatus: vi.fn(
      async (): Promise<DiarizationBackendStatus> => ({ diarizationBackend: "auto" }),
    ),
    ...over,
  };
}

describe("HfTokenSettings", () => {
  it("shows the stored-token status from the bridge", async () => {
    const api = makeApi({ getHfTokenStatus: vi.fn(async () => ({ hasToken: true })) });
    render(<HfTokenSettings api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("hf-token-status").getAttribute("data-has-token")).toBe("true"),
    );
    expect(screen.getByTestId("hf-token-status").textContent).toContain("Token saved");
  });

  it("Save sends the typed token to the bridge and clears the input", async () => {
    const api = makeApi();
    render(<HfTokenSettings api={api} />);
    await waitFor(() => expect(api.getHfTokenStatus).toHaveBeenCalled());

    const input = screen.getByTestId("hf-token-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hf_secret_token" } });
    fireEvent.click(screen.getByTestId("hf-token-save"));

    await waitFor(() => expect(api.setHfToken).toHaveBeenCalledWith({ token: "hf_secret_token" }));
    // The plaintext input is cleared the moment it is handed to main.
    await waitFor(() => expect((screen.getByTestId("hf-token-input") as HTMLInputElement).value).toBe(""));
    expect(screen.getByTestId("hf-token-save-status").textContent).toContain("saved");
    await waitFor(() =>
      expect(screen.getByTestId("hf-token-status").getAttribute("data-has-token")).toBe("true"),
    );
  });

  it("does not call the bridge when Save is clicked with an empty input", async () => {
    const api = makeApi();
    render(<HfTokenSettings api={api} />);
    await waitFor(() => expect(api.getHfTokenStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("hf-token-save"));
    expect(api.setHfToken).not.toHaveBeenCalled();
  });

  it("Clear sends a null token when one is stored", async () => {
    const api = makeApi({ getHfTokenStatus: vi.fn(async () => ({ hasToken: true })) });
    render(<HfTokenSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("hf-token-clear")).toBeTruthy());
    fireEvent.click(screen.getByTestId("hf-token-clear"));
    await waitFor(() => expect(api.setHfToken).toHaveBeenCalledWith({ token: null }));
  });

  it("shows the gated-model terms guidance", async () => {
    render(<HfTokenSettings api={makeApi()} />);
    await waitFor(() => expect(screen.getByTestId("hf-token-terms-url")).toBeTruthy());
    expect(screen.getByTestId("hf-token-terms-url").textContent).toContain(
      "pyannote/speaker-diarization-3.1",
    );
  });

  it("explains diarization works with no token by default (PRD-14)", async () => {
    render(<HfTokenSettings api={makeApi()} />);
    await waitFor(() => expect(screen.getByTestId("hf-token-note")).toBeTruthy());
    const note = screen.getByTestId("hf-token-note").textContent ?? "";
    // The no-token default + the max-accuracy opt-in are both surfaced.
    expect(note).toMatch(/no token/i);
    expect(note).toMatch(/max accuracy/i);
  });

  it("loads and saves the diarization engine preference", async () => {
    const api = makeApi({
      getDiarizationBackendStatus: vi.fn(async () => ({
        diarizationBackend: "sherpa" as const,
      })),
    });
    render(<HfTokenSettings api={api} />);
    const select = (await screen.findByTestId(
      "diarization-backend-select",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("sherpa"));

    fireEvent.change(select, { target: { value: "pyannote" } });
    await waitFor(() =>
      expect(api.setDiarizationBackend).toHaveBeenCalledWith({
        diarizationBackend: "pyannote",
      }),
    );
    expect(screen.getByTestId("diarization-backend-note").textContent).toMatch(/footprint/i);
  });
});
