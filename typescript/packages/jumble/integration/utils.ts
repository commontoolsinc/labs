import { ElementHandle, Page } from "@astral/astral";
import * as path from "@std/path";

const COMMON_CLI_PATH = path.join(import.meta.dirname!, "../../common-cli");

export const decode = (() => {
  const decoder = new TextDecoder();
  return (buffer: Uint8Array): string => decoder.decode(buffer);
})();

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  let buttons = await page.$$("button");
  for (const button of buttons) {
    if ((await button.innerText()) === "Clear Saved Credentials") {
      await button.click();
    }
  }

  // Try log in
  console.log("Logging in");

  // Click the first button, "register"
  let button = await page.$("button");
  await button!.click();

  // Click the first button, "register with passphrase"
  button = await page.$("button");
  await button!.click();

  // Get the mnemonic from textarea.
  let input = await page.$("textarea");
  const mnemonic = await input!.evaluate((textarea: HTMLInputElement) =>
    textarea.value
  );

  // Click the SECOND button, "continue to login"
  buttons = await page.$$("button");
  await buttons[1]!.click();

  // Paste the mnemonic in the input.
  input = await page.$("input");
  await input!.evaluate(
    (input: HTMLInputElement, mnemonic: string) => input.value = mnemonic,
    { args: [mnemonic] },
  );

  // Click the only button, "login"
  button = await page.$("button");
  await button!.click();
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
  const space = `ci-${Date.now()}-${
    Math.random().toString(36).substring(2, 15)
  }`;
  const { success, stderr } = await (new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "start",
      "--space",
      space,
      "--recipeFile",
      "recipes/simpleValue.tsx",
      "--cause",
      "ci",
      "--quit",
      "true",
    ],
    env: {
      "TOOLSHED_API_URL": toolshedUrl,
    },
    cwd: COMMON_CLI_PATH,
  })).output();

  if (!success) {
    throw new Error(`Failed to add charm: ${decode(stderr)}`);
  }

  return {
    charmId: "baedreic5a2muxtlgvn6u36lmcp3tdoq5sih3nbachysw4srquvga5fjtem",
    space,
  };
};

export const inspectCharm = async (
  toolshedUrl: string,
  space: string,
  charmId: string,
) => {
  const { success, stdout, stderr } = await (new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "start",
      "--space",
      space,
      "--charmId",
      charmId,
      "--quit",
      "true",
    ],
    env: {
      "TOOLSHED_API_URL": toolshedUrl,
    },
    cwd: COMMON_CLI_PATH,
  })).output();

  if (!success) {
    console.log(decode(stdout));
    throw new Error(`Failed to inspect charm: ${decode(stderr)}`);
  }

  return decode(stdout);
};
