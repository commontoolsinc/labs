import { PageErrorEvent } from "@astral/astral";
import {
  Browser,
  dismissDialogs,
  Page,
  pipeConsole,
} from "@commontools/integration";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert, assertObjectMatch } from "@std/assert";
import { sleep } from "@commontools/utils/sleep";
import "../src/globals.ts";

const API_URL = (() => {
  const url = Deno.env.get("API_URL") ?? "http://localhost:8000/";
  return url.substr(-1) === "/" ? url : `${url}/`;
})();
const FRONTEND_URL = (() => {
  const url = Deno.env.get("FRONTEND_URL") ?? API_URL;
  return url.substr(-1) === "/" ? url : `${url}/`;
})();
const HEADLESS = !!Deno.env.get("HEADLESS");
const ASTRAL_TIMEOUT = 60_000;

describe("shell login tests", () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  const exceptions: string[] = [];

  beforeAll(async () => {
    browser = await Browser.launch({
      timeout: ASTRAL_TIMEOUT,
      headless: HEADLESS,
    });
    page = await browser.newPage();
    page.addEventListener("console", pipeConsole);
    page.addEventListener("dialog", dismissDialogs);
    page.addEventListener("pageerror", (e: PageErrorEvent) => {
      console.error("Browser Page Error:", e.detail.message);
      exceptions.push(e.detail.message);
    });
  });

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it("can create a new user via passphrase", async () => {
    const spaceName = "common-knowledge";
    await page!.goto(`${FRONTEND_URL}`);
    await page!.applyConsoleFormatter();
    const state = await page!.evaluate(() => {
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
    let handle = await page!.$(
      'pierce/[test-id="register-new-key"]',
    );
    assert(handle);
    handle.click();
    await sleep(2000);
    handle = await page!.$(
      'pierce/[test-id="generate-passphrase"]',
    );
    assert(handle);
    handle.click();
    await sleep(2000);
    handle = await page!.$(
      'pierce/[test-id="passphrase-continue"]',
    );
    assert(handle);
    handle.click();
    await sleep(2000);

    handle = await page!.$("pierce/#page-title");
    assert(handle);
    const title = await handle.evaluate((el: Element) => el.textContent);
    assert(
      title?.trim() === spaceName,
      `Expect "${title?.trim()}" to be "${spaceName}"`,
    );
  });
});
