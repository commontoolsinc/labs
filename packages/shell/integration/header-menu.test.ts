import { env, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { Page } from "@commonfabric/integration";
import "../src/globals.ts";

const { FRONTEND_URL, SPACE_NAME } = env;

/** Pierce shadow DOM to find an element by selector. */
function pierce(page: Page, selector: string, timeout?: number) {
  return page.waitForSelector(selector, {
    strategy: "pierce",
    ...(timeout != null ? { timeout } : {}),
  });
}

/** Wait until the menu container has (or lacks) the "open" class. */
async function waitForMenuState(page: Page, open: boolean) {
  await waitForCondition(page, (probe, wantOpen) => {
    const el = probe.collect(".menu-container")[0];
    if (!el) return false;
    const isOpen = el.className.includes("open");
    return wantOpen ? isOpen : !isOpen;
  }, { args: [open] });
}

/** Click the nav-picker trigger to open the menu. */
async function openMenu(page: Page) {
  const trigger = await pierce(page, ".nav-picker");
  await trigger.click();
  await waitForMenuState(page, true);
}

describe("header menu tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;

  async function loginAndGoto() {
    identity = await Identity.generate({ implementation: "noble" });
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME },
      identity,
    });
  }

  it("opens and closes the menu via logo button", async () => {
    const page = shell.page();
    await loginAndGoto();

    // Menu should be closed initially
    const menuContainer = await pierce(page, ".menu-container");
    const classes = await menuContainer.evaluate(
      (el: Element) => el.className,
    );
    assert(!classes.includes("open"), "Menu should be closed initially");

    // Open menu
    await openMenu(page);

    // Click close button
    const closeBtn = await pierce(page, ".menu-close");
    await closeBtn.click();

    // Menu should be closed
    await waitForMenuState(page, false);
  });

  it("closes the menu via Escape key", async () => {
    const page = shell.page();
    await loginAndGoto();

    await openMenu(page);
    await page.keyboard.press("Escape");
    await waitForMenuState(page, false);
  });

  it("closes the menu via backdrop click", async () => {
    const page = shell.page();
    await loginAndGoto();

    await openMenu(page);

    const backdrop = await pierce(page, ".menu-backdrop");
    await backdrop.click();

    await waitForMenuState(page, false);
  });

  it("shows space name in desktop breadcrumb", async () => {
    const page = shell.page();
    await loginAndGoto();

    await waitForCondition(
      page,
      (probe, name) =>
        probe.collect(".header-space").some((el) =>
          probe.deepText(el).trim() === name
        ),
      { args: [SPACE_NAME] },
    );
  });

  it("has correct ARIA attributes", async () => {
    const page = shell.page();
    await loginAndGoto();

    // Trigger should have aria-haspopup and aria-expanded=false when closed
    const trigger = await pierce(page, ".nav-picker");
    assertEquals(
      await trigger.evaluate(
        (el: Element) => el.getAttribute("aria-haspopup"),
      ),
      "true",
    );
    assertEquals(
      await trigger.evaluate(
        (el: Element) => el.getAttribute("aria-expanded"),
      ),
      "false",
    );

    // Open menu — aria-expanded should become true
    await openMenu(page);
    await waitForCondition(
      page,
      (probe) =>
        probe.collect(".nav-picker")[0]?.getAttribute("aria-expanded") ===
          "true",
    );

    // Panel should have role=menu
    const panel = await pierce(page, ".menu-panel");
    assertEquals(
      await panel.evaluate((el: Element) => el.getAttribute("role")),
      "menu",
    );

    // Should have at least 3 menuitems
    const itemCount = await page.evaluate(() => {
      function findInShadow(
        root: Document | ShadowRoot,
        selector: string,
      ): Element[] {
        const results = Array.from(root.querySelectorAll(selector));
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            results.push(...findInShadow(el.shadowRoot, selector));
          }
        }
        return results;
      }
      return findInShadow(document, '[role="menuitem"]').length;
    });
    assert(itemCount >= 3, `Expected at least 3 menuitems, got ${itemCount}`);
  });

  it("shows contextual navigate-up label", async () => {
    const page = shell.page();
    await loginAndGoto();

    await openMenu(page);

    await waitForCondition(
      page,
      (probe) =>
        probe.collect('[role="menuitem"] .menu-item-label').some((el) =>
          probe.deepText(el).trim() === "Go Home"
        ),
    );
  });

  it("opens and closes the desktop piece switcher", async () => {
    const page = shell.page();
    await loginAndGoto();

    // Wait for the piece trigger to appear in the header breadcrumb
    await waitForCondition(
      page,
      (probe) => probe.collect(".header-piece-trigger").length > 0,
    );

    // Click the piece trigger to open the dropdown
    const trigger = await pierce(page, ".header-piece-trigger");
    await trigger.click();

    // Dropdown should appear
    await waitForCondition(
      page,
      (probe) => probe.collect(".header-piece-dropdown").length > 0,
    );

    // Re-query trigger since Lit may have re-rendered
    const updatedTrigger = await pierce(page, ".header-piece-trigger");
    assertEquals(
      await updatedTrigger.evaluate(
        (el: Element) => el.getAttribute("aria-expanded"),
      ),
      "true",
    );

    // Close via Escape
    await page.keyboard.press("Escape");

    // Dropdown should be gone
    await waitForCondition(
      page,
      (probe) => probe.collect(".header-piece-dropdown").length === 0,
    );
  });
});
