/**
 * Reads the newest test-selection manifest from the store, and answers the
 * questions a tile or a page asks of the manifest it gets back. The bucket
 * is publicly readable, so no credential is involved, and a manifest is
 * untrusted input like every record line: it goes through the shared
 * validator whole.
 *
 * A store that cannot be read, and a body that is not a manifest, are
 * faults, and are raised as such: the wall grays a tile whose collection
 * throws and puts the reason under it. Reporting nothing is reserved for a
 * store that holds no manifest, which is the one case where "none has been
 * published" is true.
 *
 * Following the dashboard's values (README.md): what this feeds reports on
 * the system. It names tests, never people.
 */

import {
  listObjects,
  type LanePlan,
  type Manifest,
  objectUrl,
  parseManifest,
} from "@commonfabric/test-support/records";
import { memo } from "./lib.ts";

export const TEST_SELECTION_BUCKET = "cf-ci-metadata";
// The trailing slash is what keeps the listing inside this version. A
// bare "v1" prefix also matches "v10", so a later schema's manifests
// would sort above these and hide the newest one a v1 reader may use.
export const TEST_SELECTION_PREFIX = "labs/test-selection/v1/";

/** The generation time in a manifest's object name, when it is one. */
export function generatedAtOf(objectName: string): string | undefined {
  return objectName.match(
    /\/manifest-(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)-[^/]*\.json\.gz$/,
  )?.[1];
}

/** Fetches the newest manifest, or `undefined` when the store holds none. */
export async function newestManifest(options: {
  bucket?: string;
  prefix?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<Manifest | undefined> {
  const bucket = options.bucket ?? TEST_SELECTION_BUCKET;
  const prefix = options.prefix ?? TEST_SELECTION_PREFIX;
  const doFetch = options.fetchImpl ?? fetch;
  const names = await listObjects({ bucket, prefix, fetch: doFetch });
  const newest = names.filter((name) => generatedAtOf(name) !== undefined)
    .sort().at(-1);
  if (newest === undefined) return undefined;
  const response = await doFetch(objectUrl(bucket, newest));
  if (!response.ok) {
    throw new Error(`manifest ${newest}: HTTP ${response.status}`);
  }
  // The store serves these with transcoding, so a plain fetch has
  // already decoded the gzip the object is stored under.
  const manifest = parseManifest(await response.text());
  if (manifest === undefined) {
    throw new Error(`manifest ${newest}: not a manifest`);
  }
  return manifest;
}

/**
 * How long one read of the manifest is shared. A manifest carries an entry
 * for every identity the store knows, so a read of one is far the largest
 * the wall makes, and the two tiles that want one are due together on this
 * same cadence and take a single read between them.
 */
export const MANIFEST_SHARE_MS = 15 * 60_000;

/** Where a tile or a page gets the manifest it reports on. */
export type ManifestReader = () => Promise<Manifest | undefined>;

/** The reader the wall runs on: one shared read per share window. */
export const sharedManifest: ManifestReader = memo(
  MANIFEST_SHARE_MS,
  () => newestManifest(),
);

/**
 * A positive number the manifest's dials name, or `fallback` when they do
 * not name one. Every manifest records the dials it was built with, so a
 * reader takes a policy number from the manifest in front of it rather
 * than from a copy here that would quietly disagree with it.
 */
export function numberDial(
  dials: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = dials[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Seconds of planned work a lane may hold, for a manifest whose dials do
 * not name a budget.
 */
export const LANE_BUDGET_FALLBACK_SECONDS = 230;

/** The budget a manifest was built with, or the fallback. */
export function laneBudgetOf(dials: Record<string, unknown>): number {
  return numberDial(dials, "LANE_BUDGET_SECONDS", LANE_BUDGET_FALLBACK_SECONDS);
}

/** Days of history a flake share is measured over, when the dials say. */
export const FLAKE_WINDOW_FALLBACK_DAYS = 60;

/** The flake share past which a test is held back, when the dials say. */
export const FLAKE_EXCLUSION_FALLBACK = 0.05;

/** How many identities one lane of the reference packing would run. */
export function laneTestCount(lane: LanePlan): number {
  return lane.batches.reduce((sum, batch) => sum + batch.identities.length, 0);
}

/** How many identities the whole packing would run. */
export function selectedCount(manifest: Manifest): number {
  return manifest.lanes.reduce(
    (total, lane) => total + laneTestCount(lane),
    0,
  );
}

/** How many identities are held back for being too noisy to judge by. */
export function flakyCount(manifest: Manifest): number {
  return manifest.withheld.filter((entry) => entry.reason === "flaky").length;
}
