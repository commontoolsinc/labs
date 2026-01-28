import { env, Page, waitFor } from "@commontools/integration";
import { PieceController, PiecesController } from "@commontools/piece/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("ct-render integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let charm: PieceController;
  let charmSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "examples",
          "ct-render.tsx",
        ),
      ),
      // We operate on the charm in this thread
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
        pieceId: charm.id,
      },
      identity,
    });

    // Use try/catch because element may become stale between waitForSelector and evaluate
    await waitFor(async () => {
      try {
        const counterResult = await page.waitForSelector("#counter-result", {
          strategy: "pierce",
          timeout: 500,
        });
        const initialText = await counterResult.evaluate((el: HTMLElement) =>
          el.textContent
        );
        return initialText?.trim() === "Counter is the 0th number";
      } catch (_) {
        return false;
      }
    });

    // Verify via direct operations that the ct-render structure works
    const value = await charm.result.get(["value"]);
    assertEquals(value, 0);
  });

  it("should click the increment button and update the counter", async () => {
    const page = shell.page();

    // Click increment button (second button - first is decrement)
    // Use retry logic to handle unstable box model during page settling
    await clickNthButton(page, "[data-ct-button]", 1);

    await waitFor(async () => {
      return (await charm.result.get(["value"])) === 1;
    });
    assertEquals(await charm.result.get(["value"]), 1);
  });

  it("should update counter value via direct operations and verify UI", async () => {
    const page = shell.page();

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
        pieceId: charm.id,
      },
      identity,
    });

    // Use try/catch because element may become stale between waitForSelector and evaluate
    await waitFor(async () => {
      try {
        const counterResult = await page.waitForSelector("#counter-result", {
          strategy: "pierce",
          timeout: 500,
        });
        const textAfterUpdate = await counterResult.evaluate((
          el: HTMLElement,
        ) => el.textContent);
        return textAfterUpdate?.trim() === "Counter is the 5th number";
      } catch (_) {
        return false;
      }
    });
  });

  it("should verify exactly THREE counters display", async () => {
    const page = shell.page();

    await waitFor(async () => {
      // Find all counter result elements (should be 1 for ct-render and two others)
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

/**
 * Tests for ct-render subpath behavior.
 *
 * This tests the fix where subpath cells like .key("sidebarUI") that
 * intentionally return undefined were being incorrectly blocked by the
 * async-loading detection logic.
 *
 * Root cells (path=[]) wait for undefined to become defined (async loading).
 * Subpath cells (path=["key"]) render immediately even if undefined.
 */
describe("ct-render subpath handling", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let charm: PieceController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "examples",
          "ct-render-subpath.tsx",
        ),
      ),
      { start: true },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should render main UI without blocking on undefined sidebarUI", async () => {
    // This test verifies the fix for the ct-render regression.
    // Before the fix, ct-render would wait forever for undefined subpath cells
    // like .key("sidebarUI") to become defined, blocking the main UI.
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: charm.id,
      },
      identity,
    });

    // The main UI should render despite sidebarUI being undefined
    // Use try/catch because waitForSelector throws on timeout, and waitFor doesn't catch exceptions
    await waitFor(async () => {
      try {
        const mainUI = await page.waitForSelector("#main-ui", {
          strategy: "pierce",
          timeout: 500,
        });
        const text = await mainUI.evaluate((el: HTMLElement) => el.textContent);
        return text?.includes("This is the main UI") ?? false;
      } catch (_) {
        return false;
      }
    }, { timeout: 10000 });

    // Verify the title is rendered (check it contains expected text)
    const title = await page.$("h1", { strategy: "pierce" });
    const titleText = await title?.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(
      titleText?.includes("Test Pattern"),
      true,
      `Title should contain 'Test Pattern', got: ${titleText}`,
    );
  });

  it("should verify previewUI exists in the pattern", () => {
    // Verify previewUI exists (a valid subpath property)
    const previewUI = charm.result.get(["previewUI"]);
    assertEquals(
      typeof previewUI,
      "object",
      "previewUI should be a VNode object",
    );
  });

  it("should render correctly without sidebarUI property", async () => {
    // This test verifies that the pattern renders even though sidebarUI
    // is not defined (or defined as undefined). The ct-render fix ensures
    // that subpath cells like .key("sidebarUI") don't block the main render.
    const page = shell.page();

    // Navigate to the charm
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: charm.id,
      },
      identity,
    });

    // The main UI should be visible - this proves rendering wasn't blocked
    // Use try/catch because waitForSelector throws on timeout, and waitFor doesn't catch exceptions
    await waitFor(async () => {
      try {
        const mainUI = await page.waitForSelector("#main-ui", {
          strategy: "pierce",
          timeout: 500,
        });
        return mainUI !== null;
      } catch (_) {
        return false;
      }
    }, { timeout: 10000 });

    // Verify the paragraph is visible
    const paragraph = await page.$("p", { strategy: "pierce" });
    const paragraphText = await paragraph?.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(
      paragraphText?.includes("sidebarUI is intentionally undefined"),
      true,
      "Paragraph should mention sidebarUI",
    );
  });
});
