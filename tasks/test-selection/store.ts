/**
 * Where manifests live, and how a lane finds the one it should obey.
 *
 * The store's writer credentials hold `objectCreator` and nothing else,
 * so an object cannot be overwritten once created. That is what makes the
 * whole store trustworthy, and it is why there is no `current.json`: a
 * reader lists the prefix and takes the newest object the store had
 * created at or before the time it is asking about. The timestamp leading
 * a name keeps a listing chronologically readable; what a resolution
 * compares is the creation time the store assigns.
 */

import {
  type Environment,
  gzipText,
  listObjectTimes,
  objectUrl,
  readEnv,
  type TimedObject,
} from "@commonfabric/test-support/records";
import { storeBucket, storePrefix } from "../test-records-config.ts";
import {
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
} from "./manifest.ts";

/**
 * The dataset area this repository's manifests belong to.
 * TEST_SELECTION_PREFIX overrides, and the infra root sets it to the area
 * rather than to a path inside one, exactly as TEST_RECORDS_PREFIX names
 * `labs/test-records` and the version segment is added by whoever builds
 * an object name.
 */
export function selectionPrefix(env: Environment = Deno.env.get): string {
  const prefix = readEnv("TEST_SELECTION_PREFIX", env);
  if (prefix !== undefined && prefix.length > 0) return prefix;
  return `${storePrefix(env).replace(/\/test-records$/, "")}/test-selection`;
}

/**
 * Where manifests of the version this reader understands are created. The
 * segment is part of every name rather than part of the configured area,
 * so a workstation and a job agree on it, and an incompatible schema
 * writes under `v2/` with readers migrating at their own pace.
 */
export function manifestPrefix(env: Environment = Deno.env.get): string {
  return `${selectionPrefix(env)}/v${MANIFEST_SCHEMA_VERSION}`;
}

/** The area the publisher's rolling aggregate is created under. */
export function statePrefix(env: Environment = Deno.env.get): string {
  return `${manifestPrefix(env)}/state`;
}

/**
 * The name one manifest is created under. The timestamp leads so that a
 * lexical listing is a chronological one, and the identifier that follows
 * makes two publishers starting in the same millisecond two objects
 * rather than a collision.
 */
export function manifestObjectName(
  generatedAt: string,
  id: string,
  env: Environment = Deno.env.get,
): string {
  return `${manifestPrefix(env)}/manifest-${generatedAt}-${id}.json.gz`;
}

/** The name one aggregate state object is created under. */
export function stateObjectName(
  day: string,
  id: string,
  env: Environment = Deno.env.get,
): string {
  return `${statePrefix(env)}/${day}-${id}.json.gz`;
}

/**
 * The generation time in a manifest's object name. Undefined for a name
 * that is not one, which is what an unrelated object under the prefix
 * looks like.
 */
export function generatedAtOf(objectName: string): string | undefined {
  const match = objectName.match(
    /\/manifest-(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)-[^/]*\.json\.gz$/,
  );
  return match?.[1];
}

/**
 * The newest manifest the store had created at or before a moment, from a
 * listing.
 *
 * The ordering is on the store's own creation time rather than on the
 * timestamp in the name. A publisher names its manifest from the moment it
 * started and creates the object when it finishes, so a name carries a
 * moment at which the object was not yet there to be read. Ordering on the
 * name would hand a lane that lists during that gap a different manifest
 * from one that lists after it, and the two would pack the corpus
 * differently.
 */
export function newestAtOrBefore(
  objects: readonly TimedObject[],
  at: string,
): string | undefined {
  let best: string | undefined;
  let bestAt = "";
  for (const { name, createdAt } of objects) {
    if (generatedAtOf(name) === undefined || createdAt > at) continue;
    // Two manifests can be created in the same millisecond, and then the
    // creation time does not order them. The name does, and every reader
    // sorts it the same way, so the lanes and the wall obey one manifest
    // rather than two that happen to share an instant.
    if (
      best === undefined || createdAt > bestAt ||
      (createdAt === bestAt && name > best)
    ) {
      best = name;
      bestAt = createdAt;
    }
  }
  return best;
}

/** What a fetch of the newest manifest found, or why it found nothing. */
export interface ManifestFetch {
  manifest?: Manifest;
  objectName?: string;

  /** Why there is no manifest, for the lane's job summary. */
  absent?: string;
}

/**
 * Fetches the newest manifest at or before a moment.
 *
 * Every way this can go wrong ends the same way: no manifest, with a
 * sentence saying so. A lane with no manifest runs the mandatory set plus
 * a deterministic slice rather than failing, so a store that is
 * unreachable slows selection down and stops nothing.
 */
export async function fetchManifest(options: {
  at: string;
  bucket?: string;
  prefix?: string;
  fetch?: typeof fetch;
  env?: Environment;
}): Promise<ManifestFetch> {
  const env = options.env ?? Deno.env.get;
  const bucket = options.bucket ?? storeBucket(env);
  const prefix = options.prefix ?? manifestPrefix(env);
  let objects: TimedObject[];
  try {
    objects = await listObjectTimes({
      bucket,
      // The trailing slash keeps the listing inside this version: a bare
      // "v1" prefix also matches "v10", whose manifests would sort above
      // these and hide the newest one this reader may use.
      prefix: `${prefix}/`,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } catch (error) {
    return { absent: `listing ${prefix} failed: ${error}` };
  }
  const objectName = newestAtOrBefore(objects, options.at);
  if (objectName === undefined) {
    return { absent: `no manifest under ${prefix} at or before ${options.at}` };
  }
  const doFetch = options.fetch ?? fetch;
  let text: string;
  try {
    const url = objectUrl(bucket, objectName);
    const response = await doFetch(url);
    if (!response.ok) {
      return {
        absent: `reading ${objectName} failed: HTTP ${response.status}`,
      };
    }
    // The store serves these with transcoding, so a plain fetch has
    // already decoded the gzip the object is stored under.
    text = await response.text();
  } catch (error) {
    return { absent: `reading ${objectName} failed: ${error}` };
  }
  const manifest = parseManifest(text);
  if (manifest === undefined) {
    return {
      objectName,
      absent: `${objectName} is not a manifest this ` +
        `reader understands`,
    };
  }
  return { manifest, objectName };
}

/** The gzipped body one manifest object holds. */
export function manifestBody(manifest: Manifest): Promise<Uint8Array> {
  return gzipText(serializeManifest(manifest));
}
