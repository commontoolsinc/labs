/**
 * Repository-owned constants for test-run recording. The canonical
 * repository name is a constant rather than something derived from git
 * remotes, because clones and forks carry misleading remote names; the
 * store coordinates default to the infra-managed bucket and can be
 * overridden through the environment the workflows set from the
 * infra-managed Actions variables.
 */

import { type Environment, readEnv } from "@commonfabric/test-support/records";

/** Canonical name of this repository in every record context. */
export const REPO = "commontoolsinc/labs";

/** GCP project holding the store and the per-person service accounts. */
export const GCP_PROJECT = "commontools-core";

/** The minting workflow the key tool dispatches and collects from. */
export const MINT_WORKFLOW_FILE = "test-records-mint.yml";

/**
 * Dataset prefixes whose submissions/local/<username>/ folders a minted
 * key can write. Grows as other repositories adopt the system.
 */
export const DATASET_PREFIXES = ["labs/test-records"];

/**
 * The store bucket; TEST_RECORDS_BUCKET overrides. An unset Actions
 * variable interpolates as an empty string, which means the default.
 */
export function storeBucket(env: Environment = Deno.env.get): string {
  const bucket = readEnv("TEST_RECORDS_BUCKET", env);
  return bucket !== undefined && bucket.length > 0 ? bucket : "cf-ci-metadata";
}

/** This repository's dataset prefix; TEST_RECORDS_PREFIX overrides. */
export function storePrefix(env: Environment = Deno.env.get): string {
  const prefix = readEnv("TEST_RECORDS_PREFIX", env);
  return prefix !== undefined && prefix.length > 0
    ? prefix
    : "labs/test-records";
}

/** Where this repository's relay creates CI objects. */
export function ciSubmissionsPrefix(env: Environment = Deno.env.get): string {
  return `${storePrefix(env)}/submissions/ci`;
}

/** Where a person's uploader creates local objects. */
export function localSubmissionsPrefix(
  username: string,
  env: Environment = Deno.env.get,
): string {
  return `${storePrefix(env)}/submissions/local/${username}`;
}

/**
 * A personal key file is the service-account key JSON with one extra
 * field: the GitHub username the minting workflow issued it for, which
 * names the holder's own submissions folder.
 */
export interface PersonalKeyFile {
  client_email: string;
  private_key: string;
  token_uri: string;
  cf_username: string;
}

/** Parses a personal key file, returning undefined when it is not one. */
export function parsePersonalKeyFile(
  text: string,
): PersonalKeyFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const key = value as Record<string, unknown>;
  if (
    typeof key.client_email !== "string" ||
    typeof key.private_key !== "string" ||
    typeof key.token_uri !== "string"
  ) {
    return undefined;
  }
  let username = key.cf_username;
  if (typeof username !== "string" || username.length === 0) {
    const match = key.client_email.match(/^test-records-gh-([^@]+)@/);
    if (!match) return undefined;
    username = match[1]!;
  }
  return {
    client_email: key.client_email,
    private_key: key.private_key,
    token_uri: key.token_uri,
    cf_username: username as string,
  };
}
