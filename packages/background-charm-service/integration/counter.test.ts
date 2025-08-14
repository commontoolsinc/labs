import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { SPACE_NAME, API_URL, FRONTEND_URL } = env;

describe("background charm counter tests", () => {
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
          "bgCounter.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it.skip("can register and interact with background counter charm", async () => {
    // FIXME(ja): currently bg process doesn't receive updates of bgCharms,
    // and so we need to start it after we register :(  We should start it here
    // this.charmCell.sink only seems to trigger when the service.ts starts -
    // restarting is currently the only way to get the charmCell to update

    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });

    const countValueEl = await page.waitForSelector(
      "#countValue",
      { strategy: "pierce" },
    );

    let text = await countValueEl?.innerText();
    let value = text ? parseInt(text) : NaN;
    console.log("before text/value", text, value);
    assert(value === 0);

    const registerBgCounterEl = await page.waitForSelector(
      "#registerBgCounter",
      { strategy: "pierce" },
    );
    registerBgCounterEl.click();

    await sleep(1000);

    // FIXME(ja):we should validate that the registration is successful
    // by looking at the state of registerBgCounterEl

    const bgProcess = new Deno.Command("deno", {
      args: ["task", "start"],
      env: {
        // API_URL,
      },
    }).spawn();

    // Wait a bit for the bg process to run
    await sleep(5000);

    // Ensure the dev server is killed after the test
    try {
      // Re-query the element to avoid stale reference
      const updatedCountValueEl = await page.waitForSelector(
        "#countValue",
        { strategy: "pierce" },
      );
      text = await updatedCountValueEl.innerText();
      value = text ? parseInt(text) : NaN;
      console.log("after text/value", text, value);
      assert(value === 1);
    } finally {
      try {
        bgProcess.kill("SIGTERM");
        bgProcess.unref();
      } catch (_) {
        // ignore if already exited
      }
    }
  });

  // FIXME(ja): add tests for error handling
});
