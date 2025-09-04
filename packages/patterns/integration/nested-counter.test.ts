import { env, Page, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("nested counter integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;
  let charm: CharmController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "nested-counter.tsx",
        ),
      ),
      // We operate on the charm in this thread
      { start: true },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the nested counter charm and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
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

    // Verify via direct operations that the nested structure works
    assertEquals(charm.result.get(["value"]), 0);
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

    // Wait for charm result update
    await waitFor(async () => {
      return await charm.result.get(["value"]) === 1;
    });
    await waitForCounter(page, "Counter is the 1st number");
  });

  it("should update counter value via direct operations and verify UI", async () => {
    const page = shell.page();
    const manager = cc!.manager();

    // Set value to 5 via direct operation
    await charm.result.set(5, ["value"]);

    // Verify we can read the value back via operations
    assertEquals(
      charm.result.get(["value"]),
      5,
      "Value should be 5 in backend",
    );

    // Navigate to the charm to see if UI reflects the change
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    await waitForCounter(page, "Counter is the 5th number");
  });

  it("should verify nested counter has multiple counter displays", async () => {
    const page = shell.page();

    await waitFor(async () => {
      // Find all counter result elements (should be 2 for nested counter)
      const counterResults = await page.$$("#counter-result", {
        strategy: "pierce",
      });
      if (counterResults.length !== 2) {
        return false;
      }
      // Verify both show the same value
      for (const counter of counterResults) {
        const text = await counter.evaluate((el: HTMLElement) =>
          el.textContent
        );
        if (text?.trim() !== "Counter is the 5th number") {
          return false;
        }
      }
      return true;
    });
  });
});

async function waitForCounter(page: Page, text: string) {
  await waitFor(async () => {
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    return (await counterResult?.innerText())?.trim() === text;
  });
}
