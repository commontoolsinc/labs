import { ElementHandle, Page } from "@astral/astral";
import * as path from "@std/path";
import { assert } from "@std/assert";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

const COMMON_CLI_PATH = path.join(import.meta.dirname!, "../../cli");

export const decode = (() => {
  const decoder = new TextDecoder();
  return (buffer: Uint8Array): string => decoder.decode(buffer);
})();

const RECORD_SNAPSHOTS = false;
const SNAPSHOTS_DIR = join(Deno.cwd(), "test_snapshots");
console.log("SNAPSHOTS_DIR=", SNAPSHOTS_DIR);

export async function snapshot(page: Page | undefined, snapshotName: string) {
  console.log(snapshotName);
  if (RECORD_SNAPSHOTS && page && snapshotName) {
    ensureDirSync(SNAPSHOTS_DIR);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePrefix = `${snapshotName}_${timestamp}`;

    const screenshot = await page.screenshot();
    Deno.writeFileSync(`${SNAPSHOTS_DIR}/${filePrefix}.png`, screenshot);

    const html = await page.content();
    Deno.writeTextFileSync(`${SNAPSHOTS_DIR}/${filePrefix}.html`, html);

    console.log(`→ Snapshot saved: ${filePrefix}`);
  }
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function tryClick(
  el?: ElementHandle | null,
  page?: Page,
): Promise<void> {
  await snapshot(page, "try_click_element");
  assert(el, "Element does not exist or is not clickable");

  await el.click();
}

export const login = async (page: Page, additionalWaitTime: number) => {
  // Wait a second :(
  // See if #user-avatar is rendered
  // Check if we're already logged in
  await sleep(1000 + additionalWaitTime);
  const avatar = await page.$("#user-avatar");
  if (avatar) {
    console.log("Already logged in");
    return;
  }

  // If not logged in, see if any credential data is
  // persisting. If so, destroy local data.
  let button = await page.$("button[aria-label='clear-credentials']");
  if (button) {
    await tryClick(button, page);
  }

  // Try log in
  console.log("Logging in");

  // Click the first button, "register"
  button = await page.$("button[aria-label='register']");
  await tryClick(button, page);

  // Click the first button, "register with passphrase"
  button = await page.$("button[aria-label='register-with-passphrase']");
  await tryClick(button, page);

  // Get the mnemonic from textarea.
  let input = await page.$("textarea[aria-label='mnemonic']");
  const mnemonic = await input!.evaluate((textarea: HTMLInputElement) =>
    textarea.value
  );

  // Click the SECOND button, "continue to login"
  button = await page.$("button[aria-label='continue-login']");
  await tryClick(button, page);

  // Paste the mnemonic in the input.
  input = await page.$("input[aria-label='enter-passphrase']");
  await input!.evaluate(
    (input: HTMLInputElement, mnemonic: string) => input.value = mnemonic,
    { args: [mnemonic] },
  );

  // Click the only button, "login"
  button = await page.$("button[aria-label='login']");
  await tryClick(button, page);
};

export const waitForSelectorWithText = async (
  page: Page,
  selector: string,
  text: string,
): Promise<ElementHandle> => {
  const retries = 30;
  const timeout = 200;

  for (let i = 0; i < retries; i++) {
    const el = await page.$(selector);
    if (!el) {
      await sleep(timeout);
      continue;
    }
    if ((await el.innerText()) === text) {
      return el;
    }
  }
  throw new Error(`Timed out waiting for "${selector}" to have text "${text}"`);
};

export const addCharm = async (toolshedUrl: string) => {
  const name = `ci-${Date.now()}-${
    Math.random().toString(36).substring(2, 15)
  }`;
  const { success, stderr } = await (new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "start",
      "--name",
      name,
      "--recipeFile",
      "../recipes/simpleValue.tsx",
      "--cause",
      "ci",
      "--quit",
      "true",
    ],
    env: {
      "TOOLSHED_API_URL": toolshedUrl,
      "OPERATOR_PASS": "common user",
    },
    cwd: COMMON_CLI_PATH,
  })).output();

  if (!success) {
    throw new Error(`Failed to add charm: ${decode(stderr)}`);
  }

  return {
    charmId: "baedreic5a2muxtlgvn6u36lmcp3tdoq5sih3nbachysw4srquvga5fjtem",
    name,
  };
};

export const inspectCharm = async (
  toolshedUrl: string,
  name: string,
  charmId: string,
) => {
  const { success, stdout, stderr } = await (new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "start",
      "--name",
      name,
      "--charmId",
      charmId,
      "--quit",
      "true",
    ],
    env: {
      "TOOLSHED_API_URL": toolshedUrl,
      "OPERATOR_PASS": "common user",
    },
    cwd: COMMON_CLI_PATH,
  })).output();

  if (!success) {
    console.log(decode(stdout));
    throw new Error(`Failed to inspect charm: ${decode(stderr)}`);
  }

  return decode(stdout);
};
