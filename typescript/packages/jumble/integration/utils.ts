import { Page } from "@astral/astral";

export const login = async (page: Page) => {
  // First, see if any credential data is
  // persisting. If so, destroy local data.
  let buttons = await page.$$("button");
  for (const button of buttons) {
    if ((await button.innerText()) === "Clear Saved Credentials") {
      await button.click();
    }
  }

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
