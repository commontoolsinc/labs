import { env } from "@commontools/integration";
import { describe, it } from "@std/testing/bdd";
import { assert, assertObjectMatch } from "@std/assert";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "../../integration/shell-utils.ts";

const { FRONTEND_URL } = env;

describe("shell login tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can create a new user via passphrase", async () => {
    const { page } = shell.get();
    const spaceName = "common-knowledge";
    await page.goto(`${FRONTEND_URL}shell`);
    await page.applyConsoleFormatter();
    const state = await page.evaluate(() => {
      return globalThis.app.state();
    });
    assertObjectMatch(state, {
      // Given a frontend URL, we don't necessarily know
      // what the backend is.
      apiUrl: state.apiUrl,
      spaceName: "common-knowledge",
    }, "Expected default app state");

    // TODO(js): Temporary workaround for upstream https://github.com/lino-levan/astral/pull/166
    // Once resolved, we could use `waitForSelector` with piercing selectors,
    // eliminating the sleeps.

    await sleep(2000);
    let handle = await page.$(
      '[test-id="register-new-key"]',
      { strategy: "pierce" },
    );
    assert(handle);
    handle.click();
    await sleep(2000);
    handle = await page.$(
      '[test-id="generate-passphrase"]',
      { strategy: "pierce" },
    );
    assert(handle);
    handle.click();
    await sleep(2000);
    handle = await page.$(
      '[test-id="passphrase-continue"]',
      { strategy: "pierce" },
    );
    assert(handle);
    handle.click();
    await sleep(2000);

    handle = await page.$("#page-title", { strategy: "pierce" });
    assert(handle);
    const title = await handle.evaluate((el: Element) => el.textContent);
    assert(
      title?.trim() === spaceName,
      `Expect "${title?.trim()}" to be "${spaceName}"`,
    );
  });
});
