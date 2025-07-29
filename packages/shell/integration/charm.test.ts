import { PageErrorEvent } from "@astral/astral";
import {
  Browser,
  dismissDialogs,
  Page,
  pipeConsole,
} from "@commontools/integration";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert, assertObjectMatch } from "@std/assert";
import { Identity } from "@commontools/identity";
import { login, registerCharm } from "./utils.ts";
import { join } from "@std/path";
import "../src/globals.ts";
import { sleep } from "@commontools/utils/sleep";

const API_URL = (() => {
  const url = Deno.env.get("API_URL") ?? "http://localhost:8000";
  return url.substr(-1) === "/" ? url : `${url}/`;
})();
const HEADLESS = !!Deno.env.get("HEADLESS");
const ASTRAL_TIMEOUT = 60_000;

describe("shell charm tests", () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let identity: Identity | undefined;
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
    identity = await Identity.generate({ implementation: "noble" });
  });

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it("can view and interact with a charm", async () => {
    const spaceName = globalThis.crypto.randomUUID();

    const charmId = await registerCharm({
      spaceName: spaceName,
      apiUrl: new URL(API_URL),
      identity: identity!,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "..",
          "..",
          "recipes",
          "counter.tsx",
        ),
      ),
    });

    // TODO(js): Remove /shell when no longer prefixed
    await page!.goto(`${API_URL}shell/${spaceName}/${charmId}`);
    await page!.applyConsoleFormatter();

    const state = await login(page!, identity!);
    assertObjectMatch({
      apiUrl: state.apiUrl,
      spaceName: state.spaceName,
      activeCharmId: state.activeCharmId,
      privateKey: state.identity?.serialize().privateKey,
    }, {
      apiUrl: state.apiUrl,
      spaceName,
      activeCharmId: charmId,
      privateKey: identity!.serialize().privateKey,
    }, "Expected app state with identity");

    await sleep(2000);
    let handle = await page!.$(
      "pierce/ct-button",
    );
    assert(handle);
    handle.click();
    await sleep(1000);
    handle.click();
    await sleep(1000);
    handle = await page!.$(
      "pierce/span",
    );
    await sleep(2000);
    const text = await handle?.innerText();
    assert(text === "Counter is the -2th number");
  });
});
