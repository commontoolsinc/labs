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

export const addCharm = async () => {
  const process = new Deno.Command("deno", {
    args: [
      "task",
      "start",
      "--space",
      "ci",
      "--recipeFile",
      "recipes/simpleValue.tsx",
      "--cause",
      "ci",
      "--quit",
      "true",
    ],
    env: {
      "TOOLSHED_API_URL": "http://localhost:8000/",
    },
    cwd: "../common-cli",
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await process.output();
  if (code !== 0) {
    throw new Error(`Failed to add charm: ${code}`);
  }

  return {
    charmId: "baedreic5a2muxtlgvn6u36lmcp3tdoq5sih3nbachysw4srquvga5fjtem",
    space: "ci",
  };
};
