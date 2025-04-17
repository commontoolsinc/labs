import { ElementHandle, Page } from "@astral/astral";
import * as path from "@std/path";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { sleep } from "@commontools/utils/sleep";

const COMMON_CLI_PATH = path.join(import.meta.dirname!, "../../cli");

export type Mutable<T> = {
  -readonly [k in keyof T]: T[k];
};

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

// Waits for `selector` element to exist,
// and then click.
export async function waitForSelectorClick(
  page: Page,
  selector: string,
): Promise<void> {
  console.log(`Waiting for "${selector}"...`);
  const el = await page.waitForSelector(selector);
  console.log(`Found "${selector}"! Clicking...`);
  await el.click();
}

export const login = async (page: Page) => {
  // Wait a second :(
  // See if #user-avatar is rendered
  // Check if we're already logged in
  await sleep(1000);
  const avatar = await page.$("#user-avatar");
  if (avatar) {
    console.log("Already logged in");
    return;
  }

  // If not logged in, see if any credential data is
  // persisting. If so, destroy local data.
  await sleep(500);
  const clearCredsButton = await page.$(
    "button[aria-label='clear-credentials']",
  );
  if (clearCredsButton) {
    await clearCredsButton.click();
  }

  // Try log in
  console.log("Logging in");

  // Click the first button, "register"
  await waitForSelectorClick(page, "button[aria-label='register']");

  // Click the first button, "register with passphrase"
  await waitForSelectorClick(
    page,
    "button[aria-label='register-with-passphrase']",
  );

  // Get the mnemonic from textarea.
  let input = await page.waitForSelector("textarea[aria-label='mnemonic']");
  const mnemonic = await input!.evaluate((textarea: HTMLInputElement) =>
    textarea.value
  );

  // Click the SECOND button, "continue to login"
  await waitForSelectorClick(page, "button[aria-label='continue-login']");

  // Paste the mnemonic in the input.
  input = await page.waitForSelector("input[aria-label='enter-passphrase']");
  await input!.evaluate(
    (input: HTMLInputElement, mnemonic: string) => input.value = mnemonic,
    { args: [mnemonic] },
  );

  // Click the only button, "login"
  await waitForSelectorClick(page, "button[aria-label='login']");

  await page.waitForSelector("#user-avatar");
};

export const waitForSelectorWithText = async (
  page: Page,
  selector: string,
  text: string,
): Promise<ElementHandle> => {
  const retries = 60;
  const timeout = 1000;
  for (let i = 0; i < retries; i++) {
    const el = await page.waitForSelector(selector);
    if ((await el.innerText()) === text) {
      return el;
    }
    await sleep(timeout);
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
      "start-ci",
      "--spaceName",
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
      "start-ci",
      "--spaceName",
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
