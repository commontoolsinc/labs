import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";

const { API_URL, FRONTEND_URL } = env;

describe("background charm counter tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can register and interact with background counter charm", async () => {
    // FIXME(ja): currently bg process doesn't receive updates of bgCharms,
    // and so we need to start it after we register :(  We should start it here
    // this.charmCell.sink only seems to trigger when the service.ts starts -
    // restarting is currently the only way to get the charmCell to update

    const { page, identity } = shell.get();
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
          "bgCounter.tsx",
        ),
      ),
    });

    // TODO(js): Remove /shell when no longer prefixed
    await page.goto(`${FRONTEND_URL}${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);
    assertEquals(
      state.identity?.serialize().privateKey,
      identity.serialize().privateKey,
    );

    await sleep(2000);
    const countValueEl = await page.$(
      "#countValue",
      { strategy: "pierce" },
    );
    console.log("countValueEl", countValueEl);
    assert(countValueEl);

    let text = await countValueEl?.innerText();
    let value = text ? parseInt(text) : NaN;
    console.log("before text/value", text, value);
    assert(value === 0);

    await sleep(2000);
    const registerBgCounterEl = await page.$(
      "#registerBgCounter",
      { strategy: "pierce" },
    );
    assert(registerBgCounterEl);
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
      const updatedCountValueEl = await page.$(
        "#countValue",
        { strategy: "pierce" },
      );
      assert(updatedCountValueEl);
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
