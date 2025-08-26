import { env, waitFor } from "@commontools/integration";
import { CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { getCharmResult, setCharmResult } from "@commontools/charm/ops";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("counter direct operations test", () => {
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
          "counter.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the counter charm and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });

    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find counter-result element");

    // Verify initial value is 0
    const initialText = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(initialText?.trim(), "Counter is the 0th number");

    const value = await getCharmResult(cc!.manager(), charmId, ["value"]);
    assertEquals(value, 0);
  });

  it("should update counter value via direct operation (live)", async () => {
    const page = shell.page();
    const manager = cc!.manager();

    // Get the counter result element
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });

    console.log("Setting counter value to 42 via direct operation");
    await setCharmResult(manager, charmId, ["value"], 42);

    await waitFor(async () => {
      const updatedText = await counterResult.evaluate((el: HTMLElement) =>
        el.textContent
      );
      return updatedText?.trim() === "Counter is the 42th number";
    });

    // Verify we can also read the value back
    await waitFor(async () =>
      (await getCharmResult(manager, charmId, ["value"])) === 42
    );
  });

  it("should update counter value and verify after page refresh", async () => {
    const page = shell.page();
    const manager = cc!.manager();

    console.log("Setting counter value to 42 via direct operation");
    await setCharmResult(manager, charmId, ["value"], 42);

    const updatedValue = await getCharmResult(manager, charmId, ["value"]);
    assertEquals(updatedValue, 42, "Value should be 42 in backend");

    // Now refresh the page by navigating to the same URL
    console.log("Refreshing the page...");
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });

    // Get the counter result element after refresh
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find counter-result element after refresh");

    // Check if the UI shows the updated value after refresh
    const textAfterRefresh = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(
      textAfterRefresh?.trim(),
      "Counter is the 42th number",
      "UI should show persisted value after refresh",
    );
  });
});
