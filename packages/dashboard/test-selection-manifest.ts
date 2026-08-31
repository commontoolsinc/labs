/**
 * Reads the newest test-selection manifest from the store. The bucket is
 * publicly readable, so no credential is involved, and a manifest is
 * untrusted input like every record line: it goes through the shared
 * validator whole, and a manifest that fails it is treated as absent.
 *
 * Following the dashboard's values (README.md): what this feeds reports on
 * the system. It names tests, never people.
 */

import {
  gunzipToText,
  listObjects,
  type Manifest,
  objectUrl,
  parseManifest,
} from "@commonfabric/test-support/records";

export const TEST_SELECTION_BUCKET = "cf-ci-metadata";
export const TEST_SELECTION_PREFIX = "labs/test-selection/v1";

/** The generation time in a manifest's object name, when it is one. */
export function generatedAtOf(objectName: string): string | undefined {
  return objectName.match(
    /\/manifest-(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)-[^/]*\.json\.gz$/,
  )?.[1];
}

/** Fetches the newest manifest, or undefined when there is not one. */
export async function newestManifest(options: {
  bucket?: string;
  prefix?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<Manifest | undefined> {
  const bucket = options.bucket ?? TEST_SELECTION_BUCKET;
  const prefix = options.prefix ?? TEST_SELECTION_PREFIX;
  const doFetch = options.fetchImpl ?? fetch;
  let names: string[];
  try {
    names = await listObjects({ bucket, prefix, fetch: doFetch });
  } catch {
    return undefined;
  }
  const newest = names.filter((name) => generatedAtOf(name) !== undefined)
    .sort().at(-1);
  if (newest === undefined) return undefined;
  try {
    const url = objectUrl(bucket, newest);
    const response = await doFetch(url);
    if (!response.ok) return undefined;
    return parseManifest(
      await gunzipToText(new Uint8Array(await response.arrayBuffer())),
    );
  } catch {
    return undefined;
  }
}
