// FIXME(ja): all this should be in the utils module

import { Page } from "@astral/astral";
import { browser, page } from "./browser.ts";
import { toolshedUrl } from "./env.ts";
export { browser };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSelectorClick(
  page: Page,
  selector: string,
): Promise<void> {
  console.log(`Waiting for "${selector}"...`);
  const el = await page.waitForSelector(selector);
  console.log(`Found "${selector}"! Clicking...`);
  await el.click();
}

// FIXME(ja): we need to move this and other browser helpers to utils
// in a way that allows it to share with the basic-flow integration tests
export async function login(name: string) {
  await goto(`/${name}`);
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

  // Check if we need to select a method first (in case of multiple auth methods available)
  const methodPassphraseButton = await page.$(
    "button[aria-label='method-passphrase']",
  );
  if (methodPassphraseButton) {
    console.log("Multiple auth methods available, selecting passphrase method");
    await methodPassphraseButton.click();
  } else {
    // Click the register with passphrase button
    await waitForSelectorClick(
      page,
      "button[aria-label='register-with-passphrase']",
    );
  }

  // Get the mnemonic from textarea.
  let input = await page.waitForSelector("textarea[aria-label='mnemonic']");
  const mnemonic = await input!.evaluate((textarea: HTMLInputElement) =>
    textarea.value
  );

  // Click the SECOND button, "continue to login"
  await waitForSelectorClick(page, "button[aria-label='continue-login']");

  // Check if we need to select a method for login (in case of multiple auth methods)
  const loginMethodPassphraseButton = await page.$(
    "button[aria-label='method-passphrase']",
  );
  if (loginMethodPassphraseButton) {
    console.log(
      "Multiple auth methods available for login, selecting passphrase method",
    );
    await loginMethodPassphraseButton.click();
  }

  // Paste the mnemonic in the input.
  input = await page.waitForSelector("input[aria-label='enter-passphrase']");
  await input!.evaluate(
    (input: HTMLInputElement, mnemonic: string) => input.value = mnemonic,
    { args: [mnemonic] },
  );

  // Click the only button, "login"
  await waitForSelectorClick(page, "button[aria-label='login']");

  await page.waitForSelector("#user-avatar");
}

export function addErrorListeners() {
  page.evaluate(() => {
    // @ts-ignore: this code is stringified and sent to browser context
    globalThis.charmRuntimeErrors = [];
    globalThis.addEventListener("common-iframe-error", (e) => {
      // @ts-ignore: this code is stringified and sent to browser context
      globalThis.charmRuntimeErrors.push(e.detail.description);
    });
  });
}

export async function checkForErrors() {
  return await page.evaluate(() => {
    // @ts-ignore: this code is stringified and sent to browser context
    return globalThis.charmRuntimeErrors;
  });
}

export async function screenshot(id: string, filename: string) {
  const screenshot = await page.screenshot();
  return Deno.writeFile(filename, screenshot);
}

export async function goto(url: string) {
  await page.goto(new URL(url, toolshedUrl).toString());
}
