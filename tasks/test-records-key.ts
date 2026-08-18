#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run=gh
/**
 * The two-invocation personal key tool, with no waiting built in.
 *
 *   deno task test-records-key request
 *     Generates and stores a fresh delivery identity, then dispatches the
 *     minting workflow when the token allows it — and prints the exact
 *     page to open and the recipient string to paste when it does not,
 *     which is the supported minimum of a read-only token plus a web
 *     browser.
 *
 *   deno task test-records-key collect
 *     Finds the completed minting run's delivery by the recipient's
 *     fingerprint, downloads and opens it, installs the key file with
 *     owner-only permissions, and prints the line to add to the shell.
 *     If the run has not finished, it says so and exits; running it again
 *     is the retry.
 *
 * Keys are a team-member workflow, and both halves are self-service. A
 * person contributing without commit access needs no key: local tests run
 * identically without one, and CI records their pull requests' runs on
 * its own.
 */

import { join } from "@std/path";
import {
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

const API = "https://api.github.com";

function configDir(): string {
  const xdg = readEnv("XDG_CONFIG_HOME");
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, "common-fabric");
  }
  const home = readEnv("HOME") ?? readEnv("USERPROFILE");
  if (home === undefined || home.length === 0) {
    throw new Error("neither XDG_CONFIG_HOME nor HOME is set");
  }
  return join(home, ".config", "common-fabric");
}

function identityPath(): string {
  return join(configDir(), "test-records-identity.json");
}

function keyFilePath(): string {
  return join(configDir(), "test-records-key.json");
}

async function githubToken(): Promise<string | undefined> {
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
}

async function github(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function loadIdentity(): Promise<KeyDeliveryIdentity | undefined> {
  try {
    return JSON.parse(
      await Deno.readTextFile(identityPath()),
    ) as KeyDeliveryIdentity;
  } catch {
    return undefined;
  }
}

async function requestCommand(): Promise<void> {
  let identity = await loadIdentity();
  if (identity === undefined) {
    identity = await generateIdentity();
    await Deno.mkdir(configDir(), { recursive: true });
    await Deno.writeTextFile(
      identityPath(),
      JSON.stringify(identity, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(`delivery identity stored: ${identityPath()}`);
  } else {
    console.log(`delivery identity already stored: ${identityPath()}`);
  }
  const recipient = identity.recipient;
  console.log(`recipient: ${recipient}`);

  const token = await githubToken();
  let username: string | undefined;
  if (token !== undefined) {
    const who = await github(token, "GET", "/user");
    if (who.ok) {
      username = (await who.json() as { login?: string }).login;
    } else {
      await who.text();
    }
  }
  if (token !== undefined && username !== undefined) {
    const dispatched = await github(
      token,
      "POST",
      `/repos/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}/dispatches`,
      { ref: "main", inputs: { recipient, username } },
    );
    await dispatched.text();
    if (dispatched.status === 204) {
      console.log(
        `minting workflow dispatched for ${username}; ` +
          "run `deno task test-records-key collect` once it finishes.",
      );
      return;
    }
    console.log(
      `this token cannot dispatch the workflow (HTTP ${dispatched.status}).`,
    );
  } else {
    console.log("no GitHub token that identifies you was found.");
  }
  console.log(`
Open the minting workflow in a browser and run it with your recipient:

    https://github.com/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}

    recipient: ${recipient}

Dispatching the workflow takes repository write access — that click is
the authorization step. If you do not have commit access, no key is
needed: your local tests run the same without one, and CI records your
pull requests' runs on its own. Otherwise, once the dispatched run
finishes:

    deno task test-records-key collect
`);
}

async function collectCommand(): Promise<void> {
  const identity = await loadIdentity();
  if (identity === undefined) {
    throw new Error(
      `no delivery identity at ${identityPath()}; ` +
        "run `deno task test-records-key request` first",
    );
  }
  const token = await githubToken();
  if (token === undefined) {
    throw new Error(
      "a GitHub token is needed to download the delivery artifact; " +
        "set GH_TOKEN or sign in with `gh auth login`",
    );
  }
  // The collector's login is read first: the delivered key must be for
  // whoever collects it, and listing only the collector's own dispatches
  // keeps the delivery findable however many other minting runs happened
  // since the request.
  const whoAmI = await github(token, "GET", "/user");
  const login = whoAmI.ok
    ? (await whoAmI.json() as { login?: string }).login
    : undefined;
  if (!whoAmI.ok) await whoAmI.text();
  if (login === undefined) {
    throw new Error(
      "cannot read your GitHub login to confirm the key is yours; " +
        "use a token that can GET /user",
    );
  }
  const fingerprint = await recipientFingerprint(identity.recipient);
  const artifactName = `test-records-key-${fingerprint}`;

  const runsRes = await github(
    token,
    "GET",
    `/repos/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}/runs` +
      `?actor=${encodeURIComponent(login)}&per_page=100`,
  );
  if (!runsRes.ok) {
    throw new Error(`listing minting runs failed: HTTP ${runsRes.status}`);
  }
  const runs = (await runsRes.json() as {
    workflow_runs?: { id: number; status?: string; conclusion?: string }[];
  }).workflow_runs ?? [];
  let sawUnfinished = false;
  for (const run of runs) {
    if (run.status !== "completed") {
      sawUnfinished = true;
      continue;
    }
    const artifactsRes = await github(
      token,
      "GET",
      `/repos/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    if (!artifactsRes.ok) {
      await artifactsRes.text();
      continue;
    }
    const artifacts = (await artifactsRes.json() as {
      artifacts?: { id: number; name: string; expired?: boolean }[];
    }).artifacts ?? [];
    const delivery = artifacts.find((artifact) =>
      artifact.name === artifactName && artifact.expired !== true
    );
    if (delivery === undefined) continue;

    const download = await github(
      token,
      "GET",
      `/repos/${REPO}/actions/artifacts/${delivery.id}/zip`,
    );
    if (!download.ok) {
      throw new Error(
        `downloading the delivery failed: HTTP ${download.status}`,
      );
    }
    const zip = new Uint8Array(await download.arrayBuffer());
    const members = await readZip(zip);
    const sealedMember = members.find((member) =>
      member.name.endsWith(".sealed")
    );
    if (sealedMember === undefined) {
      throw new Error("the delivery artifact holds no sealed key");
    }
    const box = JSON.parse(
      new TextDecoder().decode(sealedMember.data),
    ) as SealedBox;
    const keyFile = await openSealed(identity, box);
    // Decrypting proves the delivery was sealed to this identity, not that
    // its content is a key worth installing: validate the shape — which
    // requires exactly Google's HTTPS token endpoint, since the uploader
    // authenticates wherever that URL points — and require the key to be
    // for whoever collects it.
    const keyText = new TextDecoder().decode(keyFile);
    const parsedKey = parsePersonalKeyFile(keyText);
    if (parsedKey === undefined) {
      throw new Error("the delivery is not a personal test-records key file");
    }
    if (parsedKey.cf_username.toLowerCase() !== login.toLowerCase()) {
      throw new Error(
        `the delivered key was minted for ${parsedKey.cf_username}, but ` +
          `this token belongs to ${login}; refusing to install it`,
      );
    }
    await Deno.mkdir(configDir(), { recursive: true });
    await Deno.writeTextFile(
      keyFilePath(),
      keyText,
      { mode: 0o600 },
    );
    console.log(`key installed: ${keyFilePath()}

Add this line to your shell profile to opt in to test reporting:

    export ${RECORDS_KEY_FILE_VARIABLE}="${keyFilePath()}"
`);
    return;
  }
  if (sawUnfinished) {
    console.log(
      "the minting run has not finished; run this command again once it has.",
    );
    Deno.exit(1);
  }
  throw new Error(
    `no completed minting run delivered ${artifactName}; ` +
      "dispatch the workflow first with `deno task test-records-key request`",
  );
}

function usage(): never {
  console.error("usage: deno task test-records-key <request|collect>");
  Deno.exit(2);
}

if (import.meta.main) {
  const command = Deno.args[0];
  if (command === "request") {
    await requestCommand();
  } else if (command === "collect") {
    await collectCommand();
  } else {
    usage();
  }
}
