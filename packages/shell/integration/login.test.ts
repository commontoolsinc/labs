import { env } from "@commontools/integration";
import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { ShellIntegration } from "../../integration/shell-utils.ts";
import { sleep } from "@commontools/utils/sleep";

const { FRONTEND_URL } = env;

// Tests the manual logging in via passphrase.
// Other tests should use the `shell.login(identity)`
// utility to directly provide an identity.
describe("shell login tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can create a new user via passphrase", async () => {
    const page = shell.page();
    const spaceName = "common-knowledge";

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName,
    });

    const state = await shell.state();
    assert(state);
    assert(state.spaceName === "common-knowledge");

    let handle = await page.waitForSelector(
      '[test-id="register-new-key"]',
      { strategy: "pierce" },
    );
    handle.click();
    // TODO(js): If we don't sleep, we get box model errors
    // when trying to click the handles. Not sure why we need
    // to sleep at all, but at least not "duration" dependent
    await sleep(1);
    handle = await page.waitForSelector(
      '[test-id="generate-passphrase"]',
      { strategy: "pierce" },
    );
    handle.click();
    await sleep(1);
    handle = await page.waitForSelector(
      '[test-id="passphrase-continue"]',
      { strategy: "pierce" },
    );
    handle.click();

    await sleep(1);
    handle = await page.waitForSelector("#page-title", { strategy: "pierce" });
    const title = await handle.evaluate((el: Element) => el.textContent);
    assert(
      title?.trim() === spaceName,
      `Expect "${title?.trim()}" to be "${spaceName}"`,
    );
  });
});
