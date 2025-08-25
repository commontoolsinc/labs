import { env } from "@commontools/integration";
import { sleep, waitFor } from "@commontools/utils/sleep";
import { CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { getCharmResult, setCharmResult } from "@commontools/charm/ops";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("ct-render integration test", () => {
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
          "ct-render.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the nested counter charm and verify initial state", async () => {
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

    // Verify via direct operations that the ct-render structure works
    const value = await getCharmResult(cc!.manager(), charmId, ["value"]);
    assertEquals(value, 0);
  });

  it("should click the increment button and update the counter", async () => {
    const page = shell.page();

    // Find all buttons and click the increment button (second button)
    const buttons = await page.$$("[data-ct-button]", {
      strategy: "pierce",
    });
    assert(buttons.length >= 2, "Should find at least 2 buttons");

    // Click increment button (second button - first is decrement)
    await buttons[1].click();

    await waitFor(async () => {
      const value = await getCharmResult(cc!.manager(), charmId, ["value"]);
      return value === 1;
    });

    const value = await getCharmResult(cc!.manager(), charmId, ["value"]);
    assertEquals(value, 1);
  });

  it("should update counter value via direct operations and verify UI", async () => {
    const page = shell.page();
    const manager = cc!.manager();

    // Set value to 5 via direct operation
    await setCharmResult(manager, charmId, ["value"], 5);

    // Verify we can read the value back via operations
    const updatedValue = await getCharmResult(manager, charmId, ["value"]);
    assertEquals(updatedValue, 5, "Value should be 5 in backend");

    // Navigate to the charm to see if UI reflects the change
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });

    // Check if the UI shows the updated value
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    const textAfterUpdate = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(
      textAfterUpdate?.trim(),
      "Counter is the 5th number",
      "UI should show updated value from direct operation",
    );
  });

  it("should verify only ONE counter display", async () => {
    const page = shell.page();

    await waitFor(async () => {
      // Find all counter result elements (should be 1 for ct-render, not 2 like nested-counter)
      const counterResults = await page.$$("#counter-result", {
        strategy: "pierce",
      });
      return counterResults.length === 3;
    });
    const counterResults = await page.$$("#counter-result", {
      strategy: "pierce",
    });

    // Verify it shows the correct value
    const counter = counterResults[0];
    const text = await counter.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(
      text?.trim(),
      "Counter is the 5th number",
      "Single counter should show correct value",
    );
  });
});
