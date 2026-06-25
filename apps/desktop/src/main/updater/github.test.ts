/**
 * PRD-8 — GitHub manifest fetcher tests (stubbed fetch; NO real network).
 * Asserts it calls the latest-release API, finds the version.json asset, fetches
 * + parses it, and fails clearly on a non-2xx / missing asset.
 */
import { describe, expect, it, vi } from "vitest";
import { makeGithubManifestFetcher, type FetchFn } from "./github.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("makeGithubManifestFetcher", () => {
  it("fetches the latest release, locates version.json, and returns its parsed JSON", async () => {
    const manifest = { version: "1.2.3", platforms: {} };
    const fetchFn: FetchFn = vi.fn(async (url: string) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse({
          assets: [
            { name: "Loqui-win.zip", browser_download_url: "https://x/Loqui-win.zip" },
            { name: "version.json", browser_download_url: "https://x/version.json" },
          ],
        });
      }
      if (url === "https://x/version.json") return jsonResponse(manifest);
      throw new Error(`unexpected url ${url}`);
    });

    const fetcher = makeGithubManifestFetcher({ owner: "o", repo: "r", fetch: fetchFn });
    const result = await fetcher();
    expect(result).toEqual(manifest);
    // Hit the API then the asset.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      "api.github.com/repos/o/r/releases/latest",
    );
  });

  it("throws on a non-2xx API response (rate-limit/offline)", async () => {
    const fetchFn: FetchFn = vi.fn(async () => jsonResponse({}, false, 403));
    const fetcher = makeGithubManifestFetcher({ fetch: fetchFn });
    await expect(fetcher()).rejects.toThrow(/403/);
  });

  it("throws when the latest release has no version.json asset", async () => {
    const fetchFn: FetchFn = vi.fn(async () =>
      jsonResponse({ assets: [{ name: "other.zip", browser_download_url: "https://x/o.zip" }] }),
    );
    const fetcher = makeGithubManifestFetcher({ fetch: fetchFn });
    await expect(fetcher()).rejects.toThrow(/version\.json/);
  });
});
