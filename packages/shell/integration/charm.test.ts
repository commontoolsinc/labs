import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import "../src/globals.ts";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL } = env;

describe("shell charm tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can view and interact with a charm", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });
    const spaceName = globalThis.crypto.randomUUID();

    const charmId = await registerCharm({
      spaceName: spaceName,
      apiUrl: new URL(API_URL),
      identity: identity,
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

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName,
      charmId,
      identity,
    });

    let handle = await page.waitForSelector(
      "ct-button",
      { strategy: "pierce" },
    );
    handle.click();
    await sleep(1000);
    handle.click();
    await sleep(1000);
    handle = await page.waitForSelector(
      "#counter-result",
      { strategy: "pierce" },
    );
    await sleep(1000);
    const text = await handle?.innerText();
    assert(text === "Counter is the -2th number");
  });
});
