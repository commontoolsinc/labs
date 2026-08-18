/**
 * The run-owner side of local test recording: stamping a spool with the
 * run's context while its facts are certainly true, shipping a spool as one
 * gzipped object whose deterministic name makes re-shipping harmless, and
 * sweeping the spool root for orphans whose owners died. Every path here
 * fails open with a warning: recording never fails a run, and the uploader
 * makes exactly one attempt per spool.
 */

import { ulid } from "@std/ulid";
import {
  agentLabel,
  buildObjectBody,
  createObject,
  createRunSpool,
  defaultSpoolRoot,
  deleteSpool,
  type Environment,
  gzipText,
  type HeldSpool,
  listSpools,
  localObjectName,
  readEnv,
  readSpool,
  RECORD_SCHEMA_VERSION,
  RECORDS_DIR_VARIABLE,
  RECORDS_KEY_FILE_VARIABLE,
  recordsDir,
  type RunContext,
  STORE_WRITE_SCOPE,
  tokenFromKey,
  tryAdoptSpool,
} from "@commonfabric/test-support/records";
import {
  localSubmissionsPrefix,
  parsePersonalKeyFile,
  type PersonalKeyFile,
  REPO,
  storeBucket,
} from "./test-records-config.ts";

function warn(message: string): void {
  console.warn(`test records: ${message}`);
}

async function git(
  cwd: string,
  ...args: string[]
): Promise<string | undefined> {
  try {
    const { code, stdout } = await new Deno.Command("git", {
      args,
      cwd,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return undefined;
  }
}

/**
 * The context of a local run, captured at start: the commit and branch the
 * run actually began against, so a branch switch mid-run cannot mis-stamp
 * it.
 */
export async function buildLocalContext(
  cwd: string,
  env: Environment = Deno.env.get,
): Promise<RunContext> {
  const commit = await git(cwd, "rev-parse", "HEAD") ?? "unknown";
  const branch = await git(cwd, "branch", "--show-current");
  const status = await git(cwd, "status", "--porcelain");
  const context: RunContext = {
    schema: RECORD_SCHEMA_VERSION,
    line: "context",
    reportId: ulid(),
    repo: REPO,
    commit,
    dirty: status !== undefined && status.length > 0,
    env: "local",
    os: Deno.build.os,
    arch: Deno.build.arch,
    denoVersion: Deno.version.deno,
    startedAt: new Date().toISOString(),
  };
  if (branch !== undefined && branch.length > 0) context.branch = branch;
  const agent = agentLabel(env);
  if (agent !== undefined) context.agent = agent;
  return context;
}

/** Reads and parses the personal key file the environment names. */
export function readPersonalKey(
  env: Environment = Deno.env.get,
): PersonalKeyFile | undefined {
  const path = readEnv(RECORDS_KEY_FILE_VARIABLE, env);
  if (path === undefined || path.length === 0) return undefined;
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    warn(`cannot read ${RECORDS_KEY_FILE_VARIABLE} at ${path}: ${error}`);
    return undefined;
  }
  const key = parsePersonalKeyFile(text);
  if (key === undefined) {
    warn(`${path} is not a personal test-records key file`);
  }
  return key;
}

/** How an entry point participates in recording. */
export type RunRecording =
  | { mode: "off" }
  | { mode: "join"; dir: string }
  | {
    mode: "own";
    spool: HeldSpool;
    context: RunContext;
    key: PersonalKeyFile;
    spoolRoot: string;
  };

/**
 * Decides this entry point's role. An entry point that finds the records
 * variable already set joins the enclosing run as a producer. Otherwise,
 * with a personal key present, it owns a run: it creates and stamps a
 * spool for its producers and ships it when the run ends. With neither,
 * recording is off.
 */
export async function startRunRecording(
  env: Environment = Deno.env.get,
): Promise<RunRecording> {
  const joined = recordsDir(env);
  if (joined !== undefined) return { mode: "join", dir: joined };
  const key = readPersonalKey(env);
  if (key === undefined) return { mode: "off" };
  const spoolRoot = defaultSpoolRoot(env);
  if (spoolRoot === undefined) {
    warn("no spool root: neither XDG_CACHE_HOME nor HOME is set");
    return { mode: "off" };
  }
  try {
    const context = await buildLocalContext(Deno.cwd(), env);
    const spool = await createRunSpool(spoolRoot, context);
    return { mode: "own", spool, context, key, spoolRoot };
  } catch (error) {
    warn(`cannot create a spool under ${spoolRoot}: ${error}`);
    return { mode: "off" };
  }
}

/** Injectable transport, so tests ship to a stub instead of the store. */
export interface ShipTransport {
  mintToken?: (key: PersonalKeyFile) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * Ships one spool: gathers its fragments, uploads one gzipped object under
 * the key holder's own prefix, and deletes the directory. Returns true
 * when the spool was shipped (or was already in the store) and deleted.
 * One attempt; failure leaves the spool for a later sweep.
 */
export async function shipSpool(
  dir: string,
  key: PersonalKeyFile,
  env: Environment = Deno.env.get,
  transport: ShipTransport = {},
): Promise<boolean> {
  const contents = await readSpool(dir);
  for (const warning of contents.warnings) warn(warning);
  if (contents.context === undefined) {
    warn(`spool ${dir} has no readable context; leaving it in place`);
    return false;
  }
  try {
    const body = buildObjectBody(contents.context, contents.records);
    const gzipped = await gzipText(body);
    const token = transport.mintToken !== undefined
      ? await transport.mintToken(key)
      : await tokenFromKey(key, STORE_WRITE_SCOPE);
    const name = `${localSubmissionsPrefix(key.cf_username, env)}/` +
      localObjectName(contents.context);
    const createOptions: Parameters<typeof createObject>[0] = {
      bucket: storeBucket(env),
      name,
      body: gzipped,
      token,
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    };
    if (transport.fetchImpl !== undefined) {
      createOptions.fetch = transport.fetchImpl;
    }
    const result = await createObject(createOptions);
    if (result === "exists") {
      warn(`${name} was already in the store; treating it as shipped`);
    }
    await deleteSpool(dir);
    return true;
  } catch (error) {
    warn(`shipping ${dir} failed; it stays for a later sweep: ${error}`);
    return false;
  }
}

/**
 * Sweeps the spool root: adopts every directory whose owner no longer
 * holds its lock — the kernel released it on the owner's death — and ships
 * each one under its own stamped context. Directories with live owners are
 * skipped, which is what makes sweeping safe with any number of parallel
 * runs.
 */
export async function sweepSpools(
  root: string,
  key: PersonalKeyFile,
  ownDir: string | undefined,
  env: Environment = Deno.env.get,
  transport: ShipTransport = {},
): Promise<void> {
  for (const dir of await listSpools(root)) {
    if (dir === ownDir) continue;
    const adopted = await tryAdoptSpool(dir);
    if (adopted === undefined) continue;
    try {
      await shipSpool(dir, key, env, transport);
    } finally {
      adopted.close();
    }
  }
}

/**
 * Finishes an owned run: ships its spool, then sweeps the root for
 * orphans. Never throws.
 */
export async function finishRunRecording(
  recording: RunRecording,
  env: Environment = Deno.env.get,
  transport: ShipTransport = {},
): Promise<void> {
  if (recording.mode !== "own") return;
  try {
    await shipSpool(recording.spool.dir, recording.key, env, transport);
  } finally {
    recording.spool.close();
  }
  try {
    await sweepSpools(
      recording.spoolRoot,
      recording.key,
      recording.spool.dir,
      env,
      transport,
    );
  } catch (error) {
    warn(`sweeping ${recording.spoolRoot} failed: ${error}`);
  }
}

/**
 * Environment additions for an entry point's children: producers join the
 * owned run through the records variable.
 */
export function recordingChildEnv(
  recording: RunRecording,
): Record<string, string> {
  if (recording.mode === "own") {
    return { [RECORDS_DIR_VARIABLE]: recording.spool.dir };
  }
  return {};
}
