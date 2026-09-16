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
  type LanePlan,
  listObjects,
  type Manifest,
  MANIFESTS_LOOKED_BACK,
  objectUrl,
  parseManifest,
  SELECTION_AREA,
  writtenAhead,
} from "@commonfabric/test-support/records";

export const TEST_SELECTION_BUCKET = "cf-ci-metadata";
// The area is the one the publisher names, rather than a second copy of
// it here that would part company the first time either moved. The
// trailing slash is what keeps the listing inside the area, since a bare
// "v1" prefix also matches "v10".
export const TEST_SELECTION_PREFIX = `labs/test-selection/${SELECTION_AREA}/`;

/** The generation time in a manifest's object name, when it is one. */
export function generatedAtOf(objectName: string): string | undefined {
  return objectName.match(
    /\/manifest-(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)-[^/]*\.json\.gz$/,
  )?.[1];
}

/**
 * Fetches the newest manifest this reader knows a shape for, or
 * `undefined` when the store holds none it does.
 *
 * A manifest from further ahead than this reader is passed over and the
 * one before it answers instead. What that costs is a figure some hours
 * old. Raising it would leave the reader with none, and a consumer with
 * no manifest runs the whole corpus.
 */
export async function newestManifest(options: {
  bucket?: string;
  prefix?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<Manifest | undefined> {
  const names = await manifestNames(options);
  if (names.length === 0) return undefined;
  for (const name of names.slice(-MANIFESTS_LOOKED_BACK).reverse()) {
    const manifest = await manifestIfKnown(name, options);
    if (manifest !== undefined) return manifest;
  }
  // Reporting nothing here would say the store holds no manifest, which
  // is the one thing a reader this far behind its publisher must not
  // say: the store holds several and this reader can read none of them.
  throw new Error(
    `every manifest under ${options.prefix ?? TEST_SELECTION_PREFIX} this ` +
      `reader looked at was written in a newer shape than it reads`,
  );
}

/** Lists the available manifests in generation order. */
export async function manifestNames(options: {
  bucket?: string;
  prefix?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<string[]> {
  const names = await listObjects({
    bucket: options.bucket ?? TEST_SELECTION_BUCKET,
    prefix: options.prefix ?? TEST_SELECTION_PREFIX,
    fetch: options.fetchImpl ?? fetch,
  });
  return names.filter((name) => {
    const at = generatedAtOf(name);
    return at !== undefined && Number.isFinite(Date.parse(at));
  }).sort();
}

/**
 * Fetches one manifest, giving back `undefined` for one written in a
 * shape from further ahead than this reader. A body that is not a
 * manifest at all is a fault and is raised, so that a corrupt object is
 * told apart from one this reader is merely behind.
 */
async function manifestIfKnown(name: string, options: {
  bucket?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<Manifest | undefined> {
  const response = await (options.fetchImpl ?? fetch)(
    objectUrl(options.bucket ?? TEST_SELECTION_BUCKET, name),
  );
  if (!response.ok) {
    throw new Error(`manifest ${name}: HTTP ${response.status}`);
  }
  // The store serves these with transcoding, so a plain fetch has
  // already decoded the gzip the object is stored under.
  // One parse for both questions, because a manifest is the whole corpus
  // and the walk asks them of every candidate.
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }
  const manifest = parseManifest(body);
  if (manifest !== undefined) return manifest;
  if (writtenAhead(body)) return undefined;
  throw new Error(`manifest ${name}: not a manifest`);
}

/** Fetches and validates a manifest, throwing when the object is unreadable. */
export async function readManifest(name: string, options: {
  bucket?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<Manifest> {
  const manifest = await manifestIfKnown(name, options);
  if (manifest === undefined) {
    throw new Error(`manifest ${name}: written in a newer shape than this`);
  }
  return manifest;
}

/**
 * How long a manifest listing and its measurements are shared. The tiles
 * refresh on the same cadence as the workflow activity. Unchanged manifests
 * reuse their full latest inventory or their cached historical counts.
 */
export const MANIFEST_SHARE_MS = 30_000;

/** Where a tile or a page gets the manifest it reports on. */
export type ManifestReader = () => Promise<Manifest | undefined>;

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
