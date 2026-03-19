import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import type { Page } from "@astral/astral";
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
  await waitFor(async () => {
    const el = await pierce(page, ".menu-container");
    const cls = await el.evaluate((e: Element) => e.className);
    return open ? cls.includes("open") : !cls.includes("open");
  });
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

    await waitFor(async () => {
      try {
        const el = await pierce(page, ".header-space", 500);
        const text = await el.innerText();
        return text?.trim() === SPACE_NAME;
      } catch {
        return false;
      }
    });
  });

  it("has correct ARIA attributes on trigger", async () => {
    const page = shell.page();
    await loginAndGoto();

    const trigger = await pierce(page, ".nav-picker");

    const hasPopup = await trigger.evaluate(
      (el: Element) => el.getAttribute("aria-haspopup"),
    );
    assertEquals(hasPopup, "true");

    const expanded = await trigger.evaluate(
      (el: Element) => el.getAttribute("aria-expanded"),
    );
    assertEquals(expanded, "false");

    // Open menu and check expanded state changes
    await trigger.click();
    await waitFor(async () => {
      const el = await pierce(page, ".nav-picker");
      const val = await el.evaluate(
        (e: Element) => e.getAttribute("aria-expanded"),
      );
      return val === "true";
    });
  });

  it("menu panel has role=menu and items have role=menuitem", async () => {
    const page = shell.page();
    await loginAndGoto();

    await openMenu(page);

    // Check role=menu on panel
    const panel = await pierce(page, ".menu-panel");
    const panelRole = await panel.evaluate(
      (el: Element) => el.getAttribute("role"),
    );
    assertEquals(panelRole, "menu");

    // Check role=menuitem on items
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

    await waitFor(async () => {
      try {
        const el = await pierce(
          page,
          '[role="menuitem"] .menu-item-label',
          500,
        );
        const text = await el.innerText();
        return text?.trim() === "Go Home";
      } catch {
        return false;
      }
    });
  });
});
