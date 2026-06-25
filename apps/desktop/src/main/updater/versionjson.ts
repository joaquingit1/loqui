/**
 * PRD-8 — the `version.json` release-manifest generator.
 *
 * Used by the release tooling (.github/workflows/release.yml drives the CLI in
 * scripts/gen-version-json.mjs, which calls {@link generateVersionJson}) to build
 * the manifest published with every GitHub Release: it hashes each per-platform
 * artifact (sha256), reads its size, composes the download URL, and emits a
 * manifest that round-trips through {@link import("@loqui/shared").updateManifestSchema}.
 *
 * Pure logic separated from I/O: {@link buildManifest} composes the manifest from
 * already-hashed inputs (exhaustively unit-testable); {@link generateVersionJson}
 * is the thin I/O wrapper that hashes the files on disk via an injected hasher
 * (defaulting to a streamed node:crypto sha256) so tests stay hermetic.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import {
  updateManifestSchema,
  type UpdateAsset,
  type UpdateManifest,
} from "@loqui/shared";

/** One artifact to publish: its platform key, the file path, and the public URL. */
export interface ArtifactInput {
  /** The manifest platform key, e.g. "darwin-arm64" / "win32-x64". */
  platform: string;
  /** Absolute path to the built artifact (the update-channel zip). */
  file: string;
  /**
   * The download URL the asset will live at on the GitHub Release. The release
   * workflow knows this from the tag + repo + asset name.
   */
  url: string;
}

/** A pre-hashed asset (platform key + the asset record). For pure composition. */
export interface HashedAsset {
  platform: string;
  asset: UpdateAsset;
}

/**
 * Compose the manifest from already-hashed assets. Pure — no filesystem. Validates
 * the result against the shared schema so a bad URL/sha can never ship.
 */
export function buildManifest(input: {
  version: string;
  notes?: string;
  pubDate?: string;
  assets: HashedAsset[];
}): UpdateManifest {
  const platforms: Record<string, UpdateAsset> = {};
  for (const { platform, asset } of input.assets) {
    platforms[platform] = asset;
  }
  return updateManifestSchema.parse({
    version: input.version,
    notes: input.notes ?? "",
    ...(input.pubDate ? { pubDate: input.pubDate } : {}),
    platforms,
  });
}

/** The file-hashing seam (injectable; defaults to a streamed sha256). */
export type FileHasher = (file: string) => Promise<string>;

/** Default hasher: a streamed node:crypto sha256 (lowercase hex). */
export const sha256File: FileHasher = (file) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

/**
 * Generate the full manifest from artifacts on disk: hash each file, read its
 * size, and compose. The hasher + size reader are injectable for hermetic tests.
 */
export async function generateVersionJson(
  input: {
    version: string;
    notes?: string;
    pubDate?: string;
    artifacts: ArtifactInput[];
  },
  deps: { hash?: FileHasher; size?: (file: string) => number } = {},
): Promise<UpdateManifest> {
  const hash = deps.hash ?? sha256File;
  const size = deps.size ?? ((file: string) => statSync(file).size);
  const assets: HashedAsset[] = [];
  for (const art of input.artifacts) {
    const sha256 = await hash(art.file);
    assets.push({
      platform: art.platform,
      asset: { url: art.url, sha256, size: size(art.file) },
    });
  }
  return buildManifest({
    version: input.version,
    notes: input.notes,
    pubDate: input.pubDate,
    assets,
  });
}

/** Best-effort: derive the asset file name (for URL composition / logging). */
export function assetName(file: string): string {
  return basename(file);
}
