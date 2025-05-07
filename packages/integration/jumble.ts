import { Page } from "./page.ts";
import { sleep } from "@commontools/utils/sleep";

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
  let el = await page.waitForSelector("button[aria-label='register']");
  await el.click();

  // Check if we need to select a method first (in case of multiple auth methods available)
  const methodPassphraseButton = await page.$(
    "button[aria-label='method-passphrase']",
  );
  if (methodPassphraseButton) {
    console.log("Multiple auth methods available, selecting passphrase method");
    await methodPassphraseButton.click();
  } else {
    // Click the register with passphrase button
    const el = await page.waitForSelector(
      "button[aria-label='register-with-passphrase']",
    );
    await el.click();
  }

  // Get the mnemonic from textarea.
  let input = await page.waitForSelector("textarea[aria-label='mnemonic']");
  const mnemonic = await input!.evaluate((textarea: HTMLInputElement) =>
    textarea.value
  );

  // Click the SECOND button, "continue to login"
  el = await page.waitForSelector("button[aria-label='continue-login']");
  await el.click();

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
  el = await page.waitForSelector("button[aria-label='login']");
  await el.click();

  await page.waitForSelector("#user-avatar");
};
