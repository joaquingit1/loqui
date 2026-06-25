/**
 * PRD-8 — download-to-staging, sha256 verification, and zip extraction.
 *
 * INTEGRITY (the heart of the unsigned-updater trust model): the asset is
 * downloaded to a staging dir via Node `https` (NOT a browser / `open` — that is
 * load-bearing on macOS, where a browser download stamps `com.apple.quarantine`
 * on the file and Gatekeeper then blocks the swapped app). The downloaded bytes
 * are hashed and compared to the manifest sha256 BEFORE anything touches the
 * installed app; a mismatch ABORTS (the staging file is removed; the installed
 * app is fully intact). Only a verified zip is extracted to staging for the OS
 * helper to swap in.
 *
 * Resilient by construction: each download writes to a fresh `.part` file under
 * the staging dir and is renamed into place only on success; a failed / partial
 * download leaves no half-written asset and never half-swaps the app. The HTTP
 * GET is injectable (the engine's tests stub it with a local fixture) so NO real
 * network is ever required to test the verify / extract / abort paths.
 */
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import type { UpdateAsset } from "@loqui/shared";
import { extractZip } from "./zip.js";

/**
 * The HTTP GET seam. Resolves with the response body bytes for a 2xx, follows a
 * single redirect, and rejects on a non-2xx / network error. Injectable so tests
 * feed a local fixture and exercise offline / partial-download paths without a
 * real socket.
 *
 * `onProgress` (optional) reports received/total bytes for the UI.
 */
export type HttpGet = (
  url: string,
  onProgress?: (received: number, total: number) => void,
) => Promise<Buffer>;

/** Lowercase-hex sha256 of a buffer. */
export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Default HTTPS GET: streams the body, follows one level of redirect (GitHub
 * release asset URLs redirect to a signed object-store URL), and reports
 * progress. Rejects on a non-2xx after redirects.
 */
export const defaultHttpGet: HttpGet = (url, onProgress) =>
  new Promise<Buffer>((resolve, reject) => {
    const visit = (target: string, redirectsLeft: number): void => {
      const req = httpsGet(
        target,
        { headers: { "User-Agent": "Loqui-Updater", Accept: "application/octet-stream" } },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location) {
            res.resume(); // drain
            if (redirectsLeft <= 0) {
              reject(new Error(`too many redirects fetching ${url}`));
              return;
            }
            const next = new URL(location, target).toString();
            visit(next, redirectsLeft - 1);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`HTTP ${status} fetching ${target}`));
            return;
          }
          const total = Number(res.headers["content-length"] ?? 0);
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            received += chunk.length;
            onProgress?.(received, total);
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
    };
    visit(url, 5);
  });

export interface DownloadVerifyDeps {
  /** HTTP GET (defaults to the streamed HTTPS getter). */
  httpGet?: HttpGet;
}

export class Sha256MismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`sha256 mismatch: expected ${expected}, got ${actual}`);
    this.name = "Sha256MismatchError";
  }
}

/**
 * Download the asset to `<stagingDir>/<basename>.part`, verify its sha256 against
 * the manifest, and on success rename it to `<stagingDir>/<basename>`. ABORTS
 * (throws {@link Sha256MismatchError}, removes the `.part`) on a hash mismatch —
 * the installed app is never touched. Returns the path to the verified zip.
 */
export async function downloadAndVerify(
  asset: UpdateAsset,
  stagingDir: string,
  deps: DownloadVerifyDeps & {
    onProgress?: (received: number, total: number) => void;
  } = {},
): Promise<string> {
  const httpGet = deps.httpGet ?? defaultHttpGet;
  mkdirSync(stagingDir, { recursive: true });

  const fileName = assetFileName(asset.url);
  const partPath = join(stagingDir, `${fileName}.part`);
  const finalPath = join(stagingDir, fileName);

  // Clean any stale artifacts from a prior interrupted run.
  rmSync(partPath, { force: true });
  rmSync(finalPath, { force: true });

  const body = await httpGet(asset.url, deps.onProgress);

  // Write the downloaded bytes to the .part file first.
  await writeBuffer(partPath, body);

  const actual = sha256(body);
  if (actual !== asset.sha256) {
    rmSync(partPath, { force: true });
    throw new Sha256MismatchError(asset.sha256, actual);
  }

  // Verified: atomically promote .part -> the final name.
  await rename(partPath, finalPath);
  return finalPath;
}

/**
 * Extract a verified zip into `<stagingDir>/<name>`. Returns the extraction root.
 * The OS helper swaps this staged tree into place after the parent quits.
 */
export async function extractVerified(
  zipPath: string,
  destDir: string,
): Promise<string> {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const buf = await readFile(zipPath);
  await extractZip(buf, destDir);
  return destDir;
}

/** Derive the asset file name from its URL (the last non-empty path segment). */
export function assetFileName(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter((s) => s.length > 0);
    return segs[segs.length - 1] ?? "update.zip";
  } catch {
    const segs = url.split("/").filter((s) => s.length > 0);
    return segs[segs.length - 1] ?? "update.zip";
  }
}

function writeBuffer(path: string, buf: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(path);
    ws.on("error", reject);
    ws.on("finish", () => resolve());
    ws.end(buf);
  });
}
