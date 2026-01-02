import { env, Page, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-compiler";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("nested counter integration test", () => {
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
      "examples",
      "nested-counter.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath, rootPath),
      );

    charm = await cc.create(
      program, // We operate on the charm in this thread
      { start: true },
    );

    // In pull mode, create a sink to keep the charm reactive when inputs change.
    const resultCell = cc.manager().getResult(charm.getCell());
    charmSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    charmSinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("should load the nested counter charm and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        charmId: charm.id,
      },
      identity,
    });

    await waitFor(async () => {
      const counterResult = await page.waitForSelector("#counter-result", {
        strategy: "pierce",
      });
      const initialText = await counterResult.evaluate((el: HTMLElement) =>
        el.textContent
      );
      return initialText?.trim() === "Counter is the 0th number";
    });

    // Verify via direct operations that the nested structure works
    assertEquals(await charm.result.get(["value"]), 0);
  });

  it("should click the increment button and update the counter", async () => {
    const page = shell.page();

    // Click increment button (second button - first is decrement)
    // Use retry logic to handle unstable box model during page settling
    await clickNthButton(page, "[data-ct-button]", 1);

    // Wait for charm result update
    await waitFor(async () => {
      return await await charm.result.get(["value"]) === 1;
    });
    await waitForCounter(page, "Counter is the 1st number");
  });

  it("should update counter value via direct operations and verify UI", async () => {
    const page = shell.page();

    // Set value to 5 via direct operation
    await charm.result.set(5, ["value"]);

    // Verify we can read the value back via operations
    assertEquals(
      await charm.result.get(["value"]),
      5,
      "Value should be 5 in backend",
    );

    // Navigate to the charm to see if UI reflects the change
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        charmId: charm.id,
      },
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

// Clicks the nth button matching selector, retrying if the element lacks a stable box model.
// This handles timing issues where the element is found but the page
// is still settling (re-renders, layout shifts, hydration).
function clickNthButton(
  page: Page,
  selector: string,
  index: number,
): Promise<void> {
  return waitFor(async () => {
    const buttons = await page.$$(selector, { strategy: "pierce" });
    if (buttons.length <= index) return false;
    try {
      await buttons[index].click();
      return true;
    } catch (_) {
      return false;
    }
  });
}
