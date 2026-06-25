/**
 * PRD-8 — fetch the latest release's `version.json` manifest from the public
 * GitHub repo, UNAUTHENTICATED, via Node `fetch`.
 *
 * Strategy: GitHub's `/releases/latest` API returns the latest non-prerelease
 * release including its assets; we find the `version.json` asset and fetch its
 * `browser_download_url`. All of this is a single small JSON
 * request well within the 60 req/hr unauthenticated budget for a launch + 30-min
 * poll. The manifest's per-platform `url`s are the asset download URLs the
 * downloader then GETs (with sha256 verification).
 *
 * Returns the raw parsed JSON; the engine validates it against the shared schema.
 */
import {
  UPDATER_REPO_NAME,
  UPDATER_REPO_OWNER,
  UPDATE_MANIFEST_ASSET,
} from "@loqui/shared";

/** The `fetch` seam (Node 18+/Electron global). Injectable for tests. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface GithubRelease {
  assets?: { name?: string; browser_download_url?: string }[];
}

export interface GithubFetcherOptions {
  owner?: string;
  repo?: string;
  fetch?: FetchFn;
}

/**
 * Build a `fetchManifest` function bound to the public repo. It asks the GitHub
 * API for the latest release, locates the `version.json` asset, and fetches +
 * parses it. Any non-2xx / network error / missing asset throws (the engine maps
 * it to a safe `error` state).
 */
export function makeGithubManifestFetcher(
  options: GithubFetcherOptions = {},
): () => Promise<unknown> {
  const owner = options.owner ?? UPDATER_REPO_OWNER;
  const repo = options.repo ?? UPDATER_REPO_NAME;
  const doFetch: FetchFn =
    options.fetch ?? ((url, init) => fetch(url, init));

  return async (): Promise<unknown> => {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const res = await doFetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Loqui-Updater",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API HTTP ${res.status} fetching latest release`);
    }
    const release = (await res.json()) as GithubRelease;
    const asset = (release.assets ?? []).find(
      (a) => a.name === UPDATE_MANIFEST_ASSET && a.browser_download_url,
    );
    if (!asset?.browser_download_url) {
      throw new Error(`latest release has no ${UPDATE_MANIFEST_ASSET} asset`);
    }
    const manifestRes = await doFetch(asset.browser_download_url, {
      headers: { Accept: "application/json", "User-Agent": "Loqui-Updater" },
    });
    if (!manifestRes.ok) {
      throw new Error(`HTTP ${manifestRes.status} fetching ${UPDATE_MANIFEST_ASSET}`);
    }
    return (await manifestRes.json()) as unknown;
  };
}
