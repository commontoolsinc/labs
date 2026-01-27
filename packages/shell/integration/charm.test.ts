import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import "../src/globals.ts";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";
import { FileSystemProgramResolver } from "@commontools/js-compiler";

const { API_URL, SPACE_NAME, FRONTEND_URL } = env;

describe("shell charm tests", () => {
  const shell = new ShellIntegration({ pipeConsole: true });
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
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "..",
      "patterns",
      "counter",
      "counter.tsx",
    );
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath),
      );
    const charm = await cc.create(
      program,
      { start: false },
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
      view: {
        spaceName: SPACE_NAME,
        charmId,
      },
      identity,
    });

    // Helper to wait for expected counter text
    const waitForCounterText = async (expected: string) => {
      await waitFor(async () => {
        try {
          const handle = await page.waitForSelector("#counter-result", {
            strategy: "pierce",
            timeout: 500,
          });
          return (await handle.innerText())?.trim() === expected;
        } catch (_) {
          return false;
        }
      });
    };

    // Helper to click button, retrying if element is stale
    const clickDecrement = async () => {
      await waitFor(async () => {
        try {
          const button = await page.waitForSelector("#counter-decrement", {
            strategy: "pierce",
            timeout: 500,
          });
          await button.click();
          return true;
        } catch (_) {
          return false;
        }
      });
    };

    // Wait for initial state
    await waitForCounterText("Counter is the 0th number");

    // Click decrement and wait for -1
    await clickDecrement();
    await waitForCounterText("Counter is the -1th number");

    // Click decrement again and wait for -2
    await clickDecrement();
    await waitForCounterText("Counter is the -2th number");
  });
});
