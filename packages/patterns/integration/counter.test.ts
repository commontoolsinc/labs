import { env, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-compiler";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("counter direct operations test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: CharmsController;
  let charm: CharmController;
  let charmSinkCancel: (() => void) | undefined;

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
      "counter",
      "counter.tsx",
    );
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath),
      );
    charm = await cc.create(
      program, // We operate on the charm in this thread
      { start: true },
    );

    // In pull mode, create a sink to keep the charm reactive when inputs change.
    // Without this, setting values won't trigger recipe re-computation.
    const resultCell = cc.manager().getResult(charm.getCell());
    charmSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    charmSinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("should load the counter charm and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        charmId: charm.id,
      },
      identity,
    });

    // Verify initial value is 0
    await waitFor(async () => {
      const counterResult = await page.waitForSelector("#counter-result", {
        strategy: "pierce",
      });
      const initialText = await counterResult.evaluate((el: HTMLElement) =>
        el.textContent
      );
      return initialText?.trim() === "Counter is the 0th number";
    });

    assertEquals(await charm.result.get(["value"]), 0);
  });

  it("should update counter value via direct operation (live)", async () => {
    const page = shell.page();

    await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });

    await charm.result.set(42, ["value"]);

    await waitFor(async () => {
      const counterResult = await page.waitForSelector("#counter-result", {
        strategy: "pierce",
      });

      const updatedText = await counterResult.evaluate((el: HTMLElement) =>
        el.textContent
      );
      return updatedText?.trim() === "Counter is the 42th number";
    });

    // Verify we can also read the value back
    await waitFor(async () => (await charm.result.get(["value"]) === 42));
  });

  it("should update counter value and verify after page refresh", async () => {
    const page = shell.page();

    console.log("Setting counter value to 42 via direct operation");
    await charm.result.set(42, ["value"]);
    await waitFor(async () => (await charm.result.get(["value"]) === 42));

    // Now refresh the page by navigating to the same URL
    console.log("Refreshing the page...");
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        charmId: charm.id,
      },
      identity,
    });

    // Get the counter result element after refresh
    await waitFor(async () => {
      const counterResult = await page.waitForSelector("#counter-result", {
        strategy: "pierce",
      });

      const textAfterRefresh = await counterResult.evaluate((el: HTMLElement) =>
        el.textContent
      );
      return textAfterRefresh?.trim() === "Counter is the 42th number";
    });
  });
});
