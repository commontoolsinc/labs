import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import "../src/globals.ts";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, SPACE_NAME, FRONTEND_URL } = env;

describe("shell charm tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "..",
          "..",
          "recipes",
          "counter.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("can view and interact with a charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
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
