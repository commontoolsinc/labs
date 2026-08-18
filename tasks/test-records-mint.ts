#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
/**
 * Mints a personal test-records key. Runs inside the dispatch-gated minting
 * workflow with the broker's federated token: dispatching a workflow takes
 * write access to the repository, so the ability to trigger it is the
 * authorization check. The workflow creates or revives the person's service
 * account, creates their submissions/local/<username>/ folders with a
 * create-only grant, mints one key, and publishes it sealed to the
 * requester's delivery recipient as a workflow artifact named by the
 * recipient's fingerprint.
 *
 *   deno run -A tasks/test-records-mint.ts --recipient <string>
 *     --username <github-login> --out <dir>
 */

import { join } from "@std/path";
import { readEnv } from "@commonfabric/test-support/records";
import {
  isRecipient,
  recipientFingerprint,
  seal,
} from "./test-records-crypto.ts";
import {
  DATASET_PREFIXES,
  GCP_PROJECT,
  storeBucket,
} from "./test-records-config.ts";

/**
 * GitHub login rules: up to 39 characters, alphanumeric or hyphen, no
 * leading, trailing, or doubled hyphen.
 */
export function isGitHubUsername(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(name);
}

const ACCOUNT_PREFIX = "test-records-gh-";
const ACCOUNT_ID_LIMIT = 30;

/**
 * The service-account id for a username: test-records-gh-<username>
 * lowercased when it fits the 30-character account-id limit, and a
 * truncation with a six-digit digest suffix when it does not, so long
 * usernames stay deterministic and distinct. The display name always
 * carries the full username.
 */
export async function accountIdFor(username: string): Promise<string> {
  const lowered = username.toLowerCase();
  const plain = ACCOUNT_PREFIX + lowered;
  if (plain.length <= ACCOUNT_ID_LIMIT && !plain.endsWith("-")) return plain;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lowered)),
  );
  const suffix = Array.from(digest.subarray(0, 3))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const room = ACCOUNT_ID_LIMIT - ACCOUNT_PREFIX.length - suffix.length - 1;
  const head = lowered.slice(0, room).replace(/-+$/, "");
  return `${ACCOUNT_PREFIX}${head}-${suffix}`;
}

/** The display name the janitor reads the full username back from. */
export function displayNameFor(username: string): string {
  return `Test records key holder: ${username}`;
}

/** The username a display name carries, when it is one of ours. */
export function usernameOfDisplayName(displayName: string): string | undefined {
  const match = displayName.match(/^Test records key holder: (.+)$/);
  return match?.[1];
}

interface GcpClient {
  token: string;
  fetchImpl: typeof fetch;
}

async function gcp(
  client: GcpClient,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await client.fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${client.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const IAM = "https://iam.googleapis.com/v1";
const STORAGE = "https://storage.googleapis.com/storage/v1";

/** Creates or revives the account; returns its email. */
export async function ensureServiceAccount(
  client: GcpClient,
  username: string,
): Promise<string> {
  const accountId = await accountIdFor(username);
  const email = `${accountId}@${GCP_PROJECT}.iam.gserviceaccount.com`;
  const got = await gcp(
    client,
    "GET",
    `${IAM}/projects/${GCP_PROJECT}/serviceAccounts/${email}`,
  );
  if (got.status === 404) {
    const created = await gcp(
      client,
      "POST",
      `${IAM}/projects/${GCP_PROJECT}/serviceAccounts`,
      {
        accountId,
        serviceAccount: { displayName: displayNameFor(username) },
      },
    );
    if (created.status !== 200) {
      throw new Error(
        `creating ${email} failed: HTTP ${created.status} ${
          JSON.stringify(created.json).slice(0, 200)
        }`,
      );
    }
    return email;
  }
  if (got.status !== 200) {
    throw new Error(`reading ${email} failed: HTTP ${got.status}`);
  }
  const account = got.json as { disabled?: boolean };
  if (account.disabled === true) {
    const enabled = await gcp(
      client,
      "POST",
      `${IAM}/projects/${GCP_PROJECT}/serviceAccounts/${email}:enable`,
      {},
    );
    if (enabled.status !== 200) {
      throw new Error(`enabling ${email} failed: HTTP ${enabled.status}`);
    }
  }
  return email;
}

/**
 * Creates the person's folder under one dataset prefix and grants their
 * account create-only access to it.
 */
export async function ensurePersonFolder(
  client: GcpClient,
  bucket: string,
  prefix: string,
  username: string,
  email: string,
): Promise<void> {
  const folder = `${prefix}/submissions/local/${username}/`;
  const created = await gcp(
    client,
    "POST",
    `${STORAGE}/b/${encodeURIComponent(bucket)}/managedFolders`,
    { name: folder },
  );
  if (created.status !== 200 && created.status !== 409) {
    throw new Error(
      `creating folder ${folder} failed: HTTP ${created.status} ${
        JSON.stringify(created.json).slice(0, 200)
      }`,
    );
  }
  const iamUrl = `${STORAGE}/b/${encodeURIComponent(bucket)}/managedFolders/${
    encodeURIComponent(folder)
  }/iam`;
  const policyRes = await gcp(client, "GET", iamUrl);
  if (policyRes.status !== 200) {
    throw new Error(
      `reading IAM of ${folder} failed: HTTP ${policyRes.status}`,
    );
  }
  const policy = policyRes.json as {
    bindings?: { role: string; members: string[] }[];
    etag?: string;
  };
  const member = `serviceAccount:${email}`;
  const role = "roles/storage.objectCreator";
  const bindings = policy.bindings ?? [];
  const binding = bindings.find((candidate) => candidate.role === role);
  if (binding !== undefined && binding.members.includes(member)) return;
  if (binding !== undefined) {
    binding.members.push(member);
  } else {
    bindings.push({ role, members: [member] });
  }
  const updated = await gcp(client, "PUT", iamUrl, {
    bindings,
    etag: policy.etag,
  });
  if (updated.status !== 200) {
    throw new Error(
      `granting ${role} on ${folder} failed: HTTP ${updated.status} ${
        JSON.stringify(updated.json).slice(0, 200)
      }`,
    );
  }
}

/** Mints one key and returns the key file JSON with cf_username added. */
export async function mintKey(
  client: GcpClient,
  email: string,
  username: string,
): Promise<string> {
  const minted = await gcp(
    client,
    "POST",
    `${IAM}/projects/${GCP_PROJECT}/serviceAccounts/${email}/keys`,
    {},
  );
  if (minted.status !== 200) {
    throw new Error(
      `minting a key for ${email} failed: HTTP ${minted.status} ${
        JSON.stringify(minted.json).slice(0, 200)
      }`,
    );
  }
  const keyData = (minted.json as { privateKeyData?: string }).privateKeyData;
  if (keyData === undefined) {
    throw new Error("the key response carried no privateKeyData");
  }
  const decoded = atob(keyData);
  const keyFile = JSON.parse(decoded) as Record<string, unknown>;
  keyFile.cf_username = username;
  return JSON.stringify(keyFile, null, 2) + "\n";
}

function usage(): never {
  console.error(
    "usage: test-records-mint.ts --recipient <string> " +
      "--username <github-login> --out <dir>",
  );
  Deno.exit(2);
}

async function main(): Promise<void> {
  let recipient: string | undefined;
  let username: string | undefined;
  let out: string | undefined;
  const args = [...Deno.args];
  while (args.length > 0) {
    const flag = args.shift()!;
    const value = args.shift();
    if (value === undefined) usage();
    switch (flag) {
      case "--recipient":
        recipient = value.trim();
        break;
      case "--username":
        username = value.trim();
        break;
      case "--out":
        out = value;
        break;
      default:
        usage();
    }
  }
  if (recipient === undefined || username === undefined || out === undefined) {
    usage();
  }
  if (!isRecipient(recipient)) {
    throw new Error(
      "the recipient input is not a cfr1 delivery recipient; " +
        "generate one with: deno task test-records-key request",
    );
  }
  if (!isGitHubUsername(username)) {
    throw new Error(`not a GitHub username: ${username}`);
  }
  const token = readEnv("TEST_RECORDS_GCP_TOKEN");
  if (token === undefined || token.length === 0) {
    throw new Error("TEST_RECORDS_GCP_TOKEN is not set");
  }
  const client: GcpClient = { token, fetchImpl: fetch };

  const email = await ensureServiceAccount(client, username);
  console.log(`service account: ${email}`);
  const bucket = storeBucket();
  for (const prefix of DATASET_PREFIXES) {
    await ensurePersonFolder(client, bucket, prefix, username, email);
    console.log(`folder ready: ${prefix}/submissions/local/${username}/`);
  }
  const keyFile = await mintKey(client, email, username);
  const sealed = await seal(recipient, new TextEncoder().encode(keyFile));
  const fingerprint = await recipientFingerprint(recipient);
  await Deno.mkdir(out, { recursive: true });
  const path = join(out, `test-records-key-${fingerprint}.sealed`);
  await Deno.writeTextFile(path, JSON.stringify(sealed) + "\n");
  console.log(`sealed delivery written: ${path}`);
  const outputPath = readEnv("GITHUB_OUTPUT");
  if (outputPath !== undefined && outputPath.length > 0) {
    await Deno.writeTextFile(
      outputPath,
      `fingerprint=${fingerprint}\n`,
      { append: true },
    );
  }
}

if (import.meta.main) {
  await main();
}
