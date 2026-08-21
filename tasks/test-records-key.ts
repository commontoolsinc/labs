#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run=gh
/**
 * The personal key tool, in one command that finishes the job and two that
 * split it.
 *
 *   deno task test-records-key setup
 *     Generates a delivery identity, dispatches the minting workflow —
 *     or prints the page to run it in a browser, which is the supported
 *     minimum of a read-only token — then watches until the run delivers,
 *     installs the key, and exports it from the login shell's profiles.
 *     It waits as long as the run takes and stops on Ctrl-C; running it
 *     again resumes from wherever it got to. Pass --rotate to mint a
 *     replacement for a key that is already installed.
 *
 *   deno task test-records-key request
 *     The first half alone: store the identity and dispatch the workflow.
 *
 *   deno task test-records-key collect
 *     The second half alone: install the delivery of a finished run.
 *
 * Keys are a team-member workflow, and every part is self-service. A
 * person contributing without commit access needs no key: local tests run
 * identically without one, and CI records their pull requests' runs on
 * its own.
 */

import { join } from "@std/path";
import {
  type Environment,
  readEnv,
  RECORDS_KEY_FILE_VARIABLE,
} from "@commonfabric/test-support/records";
import {
  generateIdentity,
  type KeyDeliveryIdentity,
  open as openSealed,
  recipientFingerprint,
  type SealedBox,
} from "./test-records-crypto.ts";
import {
  MINT_WORKFLOW_FILE,
  parsePersonalKeyFile,
  REPO,
} from "./test-records-config.ts";
import { readZip } from "./test-records-zip.ts";
import {
  exportFromProfiles,
  type ProfileUpdate,
  reloadHint,
  shellKind,
} from "./test-records-shell-config.ts";

const API = "https://api.github.com";

/** How often the watch asks GitHub what the minting run is doing. */
const POLL_INTERVAL_MS = 5_000;

/**
 * A failure whose message is the whole report. Everything a person can
 * hit — no token, a refused dispatch, a run that failed, a delivery that
 * expired — is raised as one of these and printed as a message; anything
 * else keeps its stack, because a stack is the report for a bug in this
 * tool.
 */
export class KeyToolError extends Error {
  override name = "KeyToolError";
}

/** What the two commands reach outside the process through, injectable so
 * tests run them against stubs. */
export interface KeyToolDeps {
  env: Environment;
  fetchImpl: typeof fetch;
  githubToken: () => Promise<string | undefined>;
  /** Waits out one polling interval. */
  pause: () => Promise<void>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultGithubToken(): Promise<string | undefined> {
  return (async () => {
    const fromEnv = readEnv("GH_TOKEN") ?? readEnv("GITHUB_TOKEN");
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    try {
      const { code, stdout } = await new Deno.Command("gh", {
        args: ["auth", "token"],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (code !== 0) return undefined;
      const token = new TextDecoder().decode(stdout).trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  })();
}

function defaultDeps(): KeyToolDeps {
  return {
    env: Deno.env.get,
    fetchImpl: fetch,
    githubToken: defaultGithubToken,
    pause: () =>
      new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)),
  };
}

function configDir(env: Environment): string {
  const xdg = readEnv("XDG_CONFIG_HOME", env);
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, "common-fabric");
  }
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  if (home === undefined || home.length === 0) {
    throw new KeyToolError("Neither XDG_CONFIG_HOME nor HOME is set.");
  }
  return join(home, ".config", "common-fabric");
}

function identityPath(env: Environment): string {
  return join(configDir(env), "test-records-identity.json");
}

function keyFilePath(env: Environment): string {
  return join(configDir(env), "test-records-key.json");
}

async function github(
  deps: KeyToolDeps,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await deps.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new KeyToolError(
      `Cannot reach ${API}: ${reason(error)}`,
    );
  }
}

async function loadIdentity(
  env: Environment,
): Promise<KeyDeliveryIdentity | undefined> {
  try {
    return JSON.parse(
      await Deno.readTextFile(identityPath(env)),
    ) as KeyDeliveryIdentity;
  } catch {
    return undefined;
  }
}

/** Loads the stored delivery identity, generating one the first time. */
async function ensureIdentity(
  deps: KeyToolDeps,
): Promise<KeyDeliveryIdentity> {
  const stored = await loadIdentity(deps.env);
  if (stored !== undefined) {
    console.log(`Delivery identity: ${identityPath(deps.env)}`);
    return stored;
  }
  const identity = await generateIdentity();
  await Deno.mkdir(configDir(deps.env), { recursive: true });
  await Deno.writeTextFile(
    identityPath(deps.env),
    JSON.stringify(identity, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(`Delivery identity stored: ${identityPath(deps.env)}`);
  return identity;
}

/** The GitHub login a token belongs to. */
async function githubLogin(
  deps: KeyToolDeps,
  token: string,
): Promise<string | undefined> {
  const who = await github(deps, token, "GET", "/user");
  if (!who.ok) {
    await who.text();
    return undefined;
  }
  return (await who.json() as { login?: string }).login;
}

/** The name the workflow gives this recipient's sealed delivery. */
async function deliveryName(recipient: string): Promise<string> {
  return `test-records-key-${await recipientFingerprint(recipient)}`;
}

/** Where a browser runs the minting workflow by hand. */
function mintWorkflowUrl(): string {
  return `https://github.com/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}`;
}

interface DispatchResult {
  dispatched: boolean;
  username?: string;
  /** GitHub's clock at the dispatch, which bounds the run's creation. */
  at?: number;
}

/**
 * Asks GitHub to run the minting workflow. Dispatching takes repository
 * write access — that call is the authorization check — so a token that
 * can only read comes back undispatched and the caller falls back to the
 * browser.
 */
async function dispatchMint(
  deps: KeyToolDeps,
  token: string,
  recipient: string,
  username: string,
): Promise<DispatchResult> {
  const dispatched = await github(
    deps,
    token,
    "POST",
    `/repos/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}/dispatches`,
    { ref: "main", inputs: { recipient, username } },
  );
  const at = Date.parse(dispatched.headers.get("date") ?? "");
  await dispatched.text();
  if (dispatched.status === 204) {
    const result: DispatchResult = { dispatched: true, username };
    if (!Number.isNaN(at)) result.at = at;
    return result;
  }
  console.log(
    `This token cannot dispatch the workflow (HTTP ${dispatched.status}).`,
  );
  return { dispatched: false };
}

/** What to print when the dispatch has to happen in a browser. */
function browserInstructions(recipient: string): string {
  return `
Open the minting workflow and run it with your recipient:

    ${mintWorkflowUrl()}

    Recipient: ${recipient}

Dispatching the workflow takes repository write access — that click is
the authorization step. If you do not have commit access, no key is
needed: your local tests run the same without one, and CI records your
pull requests' runs on its own.`;
}

interface MintRun {
  id: number;
  status: string;
  conclusion?: string;
  html_url?: string;
  created_at?: string;
  actor?: { login?: string };
  display_title?: string;
  name?: string;
}

/** A minting run this requester's, and the delivery it published. */
interface RunMatch {
  run: MintRun;
  /** The delivery artifact, when one identified the run. */
  artifact?: number;
}

/** What a search for the requester's own minting run works from. */
interface RunSearch {
  token: string;
  recipient: string;
  artifactName: string;
  login: string;
  /**
   * GitHub's clock at the moment this attempt began, bounding how far
   * back a run can be and still be this attempt's. Unset examines every
   * run listed, which is what one collection wants and a repeating watch
   * does not.
   */
  notBefore?: number;
}

interface RunSearchResult {
  match?: RunMatch;
  /** GitHub's clock at the listing, for bounding later searches. */
  serverDate?: number;
}

/**
 * The requester's own minting run, newest first, by three tests in
 * descending order of certainty. A run whose name carries the recipient
 * is minting for it. A completed run that published this recipient's
 * delivery minted for it, whatever its name says — which is what a run
 * from a workflow version that does not name its recipient is found by.
 * Failing both, the newest run this person dispatched within this
 * attempt is the one they are waiting on, which is all that can be said
 * of a run that is still going and does not name what it is minting.
 */
async function findMintRun(
  deps: KeyToolDeps,
  search: RunSearch,
): Promise<RunSearchResult> {
  const res = await github(
    deps,
    search.token,
    "GET",
    `/repos/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}/runs?per_page=50`,
  );
  if (!res.ok) {
    await res.text();
    throw new KeyToolError(`Listing minting runs failed: HTTP ${res.status}`);
  }
  const listed = Date.parse(res.headers.get("date") ?? "");
  const result: RunSearchResult = {};
  if (!Number.isNaN(listed)) result.serverDate = listed;
  const runs = (await res.json() as { workflow_runs?: MintRun[] })
    .workflow_runs ?? [];

  const namesRecipient = (run: MintRun): boolean =>
    `${run.display_title ?? ""}\n${run.name ?? ""}`.includes(search.recipient);
  const candidates = runs.filter((run) => {
    const mine = namesRecipient(run) ||
      run.actor?.login?.toLowerCase() === search.login.toLowerCase();
    if (!mine) return false;
    if (search.notBefore === undefined) return true;
    const created = Date.parse(run.created_at ?? "");
    return !Number.isNaN(created) && created >= search.notBefore;
  });

  for (const run of candidates) {
    const named = namesRecipient(run);
    if (run.status === "completed" && run.conclusion === "success") {
      const artifact = await deliveryArtifact(
        deps,
        search.token,
        run.id,
        search.artifactName,
      );
      if (artifact !== undefined) {
        return { ...result, match: { run, artifact } };
      }
      // A run that named this recipient and delivered nothing is still
      // the run to report on; one that named nothing is unidentifiable.
      if (named) return { ...result, match: { run } };
      continue;
    }
    if (named) return { ...result, match: { run } };
  }

  if (search.notBefore !== undefined) {
    const attributed = candidates[0];
    return attributed === undefined
      ? result
      : { ...result, match: { run: attributed } };
  }
  const running = candidates.find((run) => run.status !== "completed");
  return running === undefined
    ? result
    : { ...result, match: { run: running } };
}

/** The id of a run's sealed delivery, when it published an unexpired one. */
async function deliveryArtifact(
  deps: KeyToolDeps,
  token: string,
  runId: number,
  artifactName: string,
): Promise<number | undefined> {
  const res = await github(
    deps,
    token,
    "GET",
    `/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  if (!res.ok) {
    await res.text();
    throw new KeyToolError(
      `Listing the artifacts of run ${runId} failed: HTTP ${res.status}`,
    );
  }
  const artifacts = (await res.json() as {
    artifacts?: { id: number; name: string; expired?: boolean }[];
  }).artifacts ?? [];
  return artifacts.find((artifact) =>
    artifact.name === artifactName && artifact.expired !== true
  )?.id;
}

/**
 * Downloads one sealed delivery, opens it with the stored identity, and
 * installs the key file. Decrypting proves the delivery was sealed to
 * this identity, not that its content is a key worth installing:
 * validate the shape — which requires exactly Google's HTTPS token
 * endpoint, since the uploader authenticates wherever that URL points —
 * and require the key to be for whoever collects it.
 */
async function installDelivery(
  deps: KeyToolDeps,
  token: string,
  identity: KeyDeliveryIdentity,
  login: string,
  artifactId: number,
): Promise<string> {
  const download = await github(
    deps,
    token,
    "GET",
    `/repos/${REPO}/actions/artifacts/${artifactId}/zip`,
  );
  if (!download.ok) {
    await download.text();
    throw new KeyToolError(
      `Downloading the delivery failed: HTTP ${download.status}`,
    );
  }
  const zip = new Uint8Array(await download.arrayBuffer());
  const members = await readZip(zip);
  const sealedMember = members.find((member) =>
    member.name.endsWith(".sealed")
  );
  if (sealedMember === undefined) {
    throw new KeyToolError("The delivery artifact holds no sealed key.");
  }
  const box = JSON.parse(
    new TextDecoder().decode(sealedMember.data),
  ) as SealedBox;
  let keyFile: Uint8Array;
  try {
    keyFile = await openSealed(identity, box);
  } catch (error) {
    throw new KeyToolError(
      `The delivery does not open with the identity at ` +
        `${identityPath(deps.env)}: ${reason(error)}`,
    );
  }
  const keyText = new TextDecoder().decode(keyFile);
  const parsedKey = parsePersonalKeyFile(keyText);
  if (parsedKey === undefined) {
    throw new KeyToolError(
      "The delivery is not a personal test-records key file.",
    );
  }
  if (parsedKey.cf_username.toLowerCase() !== login.toLowerCase()) {
    throw new KeyToolError(
      `The delivered key was minted for ${parsedKey.cf_username}, but ` +
        `this token belongs to ${login}; refusing to install it`,
    );
  }
  await Deno.mkdir(configDir(deps.env), { recursive: true });
  const path = keyFilePath(deps.env);
  await Deno.writeTextFile(path, keyText, { mode: 0o600 });
  return path;
}

/**
 * Exports the key file from the login shell's profiles and says what
 * each file's update did.
 */
async function exportKeyFile(
  deps: KeyToolDeps,
  path: string,
): Promise<ProfileUpdate[]> {
  const updates = await exportFromProfiles(
    RECORDS_KEY_FILE_VARIABLE,
    path,
    deps.env,
  );
  if (updates.length === 0) {
    console.log(`
No shell profile to update. Export the key file yourself:

    ${RECORDS_KEY_FILE_VARIABLE}=${path}`);
    return updates;
  }
  const kind = shellKind(deps.env);
  for (const update of updates) {
    if (update.outcome === "added") {
      console.log(`${RECORDS_KEY_FILE_VARIABLE} exported from ${update.path}`);
    } else if (update.outcome === "present") {
      console.log(`${update.path} already exports the key file.`);
    } else {
      console.log(`
${update.path} already sets ${RECORDS_KEY_FILE_VARIABLE} elsewhere:

    ${update.existing}

Left alone. Point it at ${path} to record from this key.`);
    }
  }
  const added = updates.filter((update) => update.outcome === "added");
  if (added.length > 0) {
    console.log(`
Every new shell records its test runs. For the one you are in:

    ${reloadHint(added[0]!.path, kind)}`);
  }
  return updates;
}

/** The key already installed on this workstation, when there is one. */
async function installedKey(
  env: Environment,
): Promise<{ path: string; username: string } | undefined> {
  const path = keyFilePath(env);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
  const parsed = parsePersonalKeyFile(text);
  if (parsed === undefined) return undefined;
  return { path, username: parsed.cf_username };
}

export async function requestCommand(
  deps: KeyToolDeps = defaultDeps(),
): Promise<void> {
  const identity = await ensureIdentity(deps);
  console.log(`Recipient: ${identity.recipient}`);

  const token = await deps.githubToken();
  const username = token === undefined
    ? undefined
    : await githubLogin(deps, token);
  if (token === undefined) {
    console.log(
      "No GitHub token was found; set GH_TOKEN or sign in with " +
        "`gh auth login` to dispatch from here.",
    );
  } else if (username === undefined) {
    console.log("This token cannot read your GitHub login.");
  } else {
    const dispatch = await dispatchMint(
      deps,
      token,
      identity.recipient,
      username,
    );
    if (dispatch.dispatched) {
      console.log(
        `Minting workflow dispatched for ${username}; ` +
          "run `deno task test-records-key collect` once it finishes.",
      );
      return;
    }
  }
  console.log(`${browserInstructions(identity.recipient)}

Once the run finishes:

    deno task test-records-key collect
`);
}

/**
 * Watches until the minting run delivers, printing what it is doing as
 * that changes. There is no bound on the wait: a run takes as long as it
 * takes, and Ctrl-C is how a person stops watching.
 */
async function awaitDelivery(
  deps: KeyToolDeps,
  search: RunSearch,
): Promise<number> {
  let said: string | undefined;
  const say = (line: string): void => {
    if (line === said) return;
    said = line;
    console.log(line);
  };
  for (;;) {
    const { match, serverDate } = await findMintRun(deps, search);
    // Once the first listing has said what time GitHub thinks it is,
    // every later one is bounded by it, so a watch left running does not
    // re-examine runs from before it started.
    if (search.notBefore === undefined && serverDate !== undefined) {
      search.notBefore = serverDate;
    }
    if (match === undefined) {
      say("Waiting for the minting run to appear...");
    } else if (match.artifact !== undefined) {
      say(`Minting run succeeded: ${runUrl(match.run)}`);
      return match.artifact;
    } else if (match.run.status !== "completed") {
      say(
        `Minting run ${match.run.status.replace("_", " ")}: ${
          runUrl(match.run)
        }`,
      );
    } else if (match.run.conclusion === "success") {
      throw new KeyToolError(
        `The minting run published no delivery for this recipient, or it ` +
          `has expired: ${runUrl(match.run)}\n` +
          "Deliveries are kept for seven days; mint a fresh one with " +
          "`deno task test-records-key setup --rotate`.",
      );
    } else {
      throw new KeyToolError(
        `The minting run finished as ${match.run.conclusion ?? "unfinished"}: ${
          runUrl(match.run)
        }\n` +
          "Open it to see which step failed. Run " +
          "`deno task test-records-key setup` again once the cause is fixed.",
      );
    }
    await deps.pause();
  }
}

function runUrl(run: MintRun): string {
  return run.html_url ?? `https://github.com/${REPO}/actions/runs/${run.id}`;
}

/**
 * The whole opt-in: identity, dispatch, watch, install, export. Rerunning
 * it resumes — the identity is reused, and a run already under way is the
 * one it watches.
 */
export async function setupCommand(
  deps: KeyToolDeps = defaultDeps(),
  options: { rotate?: boolean } = {},
): Promise<number> {
  const existing = await installedKey(deps.env);
  if (existing !== undefined && options.rotate !== true) {
    console.log(
      `A reporting key for ${existing.username} is installed at ` +
        `${existing.path}`,
    );
    await exportKeyFile(deps, existing.path);
    console.log(`
Minting another key revokes this one, on every machine holding a copy.
To rotate deliberately:

    deno task test-records-key setup --rotate
`);
    return 0;
  }

  const token = await deps.githubToken();
  if (token === undefined) {
    throw new KeyToolError(
      "A GitHub token is needed to mint and collect a key; set GH_TOKEN " +
        "or sign in with `gh auth login`",
    );
  }
  const login = await githubLogin(deps, token);
  if (login === undefined) {
    throw new KeyToolError(
      "Cannot read your GitHub login; use a token that can GET /user.",
    );
  }

  const identity = await ensureIdentity(deps);
  console.log(`recipient: ${identity.recipient}`);
  const dispatch = await dispatchMint(deps, token, identity.recipient, login);
  if (dispatch.dispatched) {
    console.log(`Minting workflow dispatched for ${login}`);
  } else {
    console.log(`${browserInstructions(identity.recipient)}

Waiting for that run — this command collects the key on its own once it
finishes. Ctrl-C stops watching; rerunning picks up where it left off.
`);
  }

  const search: RunSearch = {
    token,
    recipient: identity.recipient,
    artifactName: await deliveryName(identity.recipient),
    login,
  };
  if (dispatch.at !== undefined) search.notBefore = dispatch.at;
  const artifact = await awaitDelivery(deps, search);
  const path = await installDelivery(deps, token, identity, login, artifact);
  console.log(`Key installed: ${path}`);
  await exportKeyFile(deps, path);
  return 0;
}

export async function collectCommand(
  deps: KeyToolDeps = defaultDeps(),
): Promise<number> {
  const identity = await loadIdentity(deps.env);
  if (identity === undefined) {
    throw new KeyToolError(
      `No delivery identity at ${identityPath(deps.env)}; ` +
        "run `deno task test-records-key setup` first",
    );
  }
  const token = await deps.githubToken();
  if (token === undefined) {
    throw new KeyToolError(
      "A GitHub token is needed to download the delivery artifact; " +
        "set GH_TOKEN or sign in with `gh auth login`",
    );
  }
  // The collector's login is read first: the delivered key must be for
  // whoever collects it.
  const login = await githubLogin(deps, token);
  if (login === undefined) {
    throw new KeyToolError(
      "Cannot read your GitHub login to confirm the key is yours; " +
        "use a token that can GET /user",
    );
  }
  const { match } = await findMintRun(deps, {
    token,
    recipient: identity.recipient,
    artifactName: await deliveryName(identity.recipient),
    login,
  });
  if (match === undefined) {
    throw new KeyToolError(
      "No minting run for this recipient; dispatch one with " +
        "`deno task test-records-key setup`.",
    );
  }
  if (match.artifact === undefined) {
    if (match.run.status !== "completed") {
      console.log(
        `The minting run is ${match.run.status.replace("_", " ")}: ${
          runUrl(match.run)
        }\nRun this command again once it has finished, or wait for it ` +
          "with `deno task test-records-key setup`.",
      );
      return 1;
    }
    if (match.run.conclusion !== "success") {
      throw new KeyToolError(
        `The minting run finished as ${match.run.conclusion ?? "unfinished"}: ${
          runUrl(match.run)
        }\n` +
          "Open it to see which step failed, then run " +
          "`deno task test-records-key setup` again.",
      );
    }
    throw new KeyToolError(
      `The minting run published no delivery for this recipient, or it has ` +
        `expired: ${runUrl(match.run)}\n` +
        "Deliveries are kept for seven days; mint a fresh one with " +
        "`deno task test-records-key setup --rotate`.",
    );
  }
  const artifact = match.artifact;
  const path = await installDelivery(deps, token, identity, login, artifact);
  console.log(`Key installed: ${path}`);
  await exportKeyFile(deps, path);
  return 0;
}

function usage(): never {
  console.error(
    "usage: deno task test-records-key <setup [--rotate]|request|collect>",
  );
  Deno.exit(2);
}

/**
 * Reports a stop as a stop rather than as a stack, and returns the call
 * that takes the listener back off: a live signal listener holds the
 * event loop open, so the command would not end on its own with one
 * still registered.
 */
function watchForInterrupt(): () => void {
  const stop = () => {
    console.log(`
Stopped watching. The minting run carries on; pick the key up with

    deno task test-records-key setup
`);
    Deno.exit(130);
  };
  try {
    Deno.addSignalListener("SIGINT", stop);
  } catch {
    // A platform without SIGINT delivery stops the way it always did.
    return () => {};
  }
  return () => Deno.removeSignalListener("SIGINT", stop);
}

if (import.meta.main) {
  const [command, ...rest] = Deno.args;
  try {
    if (command === "setup") {
      const rotate = rest.includes("--rotate");
      if (rest.some((argument) => argument !== "--rotate")) usage();
      const stopWatching = watchForInterrupt();
      try {
        const code = await setupCommand(defaultDeps(), { rotate });
        if (code !== 0) Deno.exit(code);
      } finally {
        stopWatching();
      }
    } else if (command === "request") {
      if (rest.length > 0) usage();
      await requestCommand();
    } else if (command === "collect") {
      if (rest.length > 0) usage();
      const code = await collectCommand();
      if (code !== 0) Deno.exit(code);
    } else {
      usage();
    }
  } catch (error) {
    if (!(error instanceof KeyToolError)) throw error;
    console.error(`\n${error.message}\n`);
    Deno.exit(1);
  }
}
