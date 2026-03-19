import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import "../src/globals.ts";

const { FRONTEND_URL, SPACE_NAME } = env;

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
    const menuContainer = await page.waitForSelector(".menu-container", {
      strategy: "pierce",
    });
    const classes = await menuContainer.evaluate(
      (el: Element) => el.className,
    );
    assert(!classes.includes("open"), "Menu should be closed initially");

    // Click the logo/nav-picker to open
    const trigger = await page.waitForSelector(".nav-picker", {
      strategy: "pierce",
    });
    await trigger.click();

    // Menu should be open
    await waitFor(async () => {
      const el = await page.waitForSelector(".menu-container", {
        strategy: "pierce",
      });
      const cls = await el.evaluate((e: Element) => e.className);
      return cls.includes("open");
    });

    // Click close button
    const closeBtn = await page.waitForSelector(".menu-close", {
      strategy: "pierce",
    });
    await closeBtn.click();

    // Menu should be closed
    await waitFor(async () => {
      const el = await page.waitForSelector(".menu-container", {
        strategy: "pierce",
      });
      const cls = await el.evaluate((e: Element) => e.className);
      return !cls.includes("open");
    });
  });

  it("closes the menu via Escape key", async () => {
    const page = shell.page();
    await loginAndGoto();

    // Open the menu
    const trigger = await page.waitForSelector(".nav-picker", {
      strategy: "pierce",
    });
    await trigger.click();

    await waitFor(async () => {
      const el = await page.waitForSelector(".menu-container", {
        strategy: "pierce",
      });
      const cls = await el.evaluate((e: Element) => e.className);
      return cls.includes("open");
    });

    // Press Escape
    await page.keyboard.press("Escape");

    // Menu should be closed
    await waitFor(async () => {
      const el = await page.waitForSelector(".menu-container", {
        strategy: "pierce",
      });
      const cls = await el.evaluate((e: Element) => e.className);
      return !cls.includes("open");
    });
  });

  it("closes the menu via backdrop click", async () => {
    const page = shell.page();
    await loginAndGoto();

    // Open the menu
    const trigger = await page.waitForSelector(".nav-picker", {
      strategy: "pierce",
    });
    await trigger.click();

    await waitFor(async () => {
      const el = await page.waitForSelector(".menu-container", {
        strategy: "pierce",
      });
      const cls = await el.evaluate((e: Element) => e.className);
      return cls.includes("open");
    });

    // Click the backdrop
    const backdrop = await page.waitForSelector(".menu-backdrop", {
      strategy: "pierce",
    });
    await backdrop.click();

    // Menu should be closed
    await waitFor(async () => {
      const el = await page.waitForSelector(".menu-container", {
        strategy: "pierce",
      });
      const cls = await el.evaluate((e: Element) => e.className);
      return !cls.includes("open");
    });
  });

  it("shows space name in desktop breadcrumb", async () => {
    const page = shell.page();
    await loginAndGoto();

    await waitFor(async () => {
      try {
        const el = await page.waitForSelector(".header-space", {
          strategy: "pierce",
          timeout: 500,
        });
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

    const trigger = await page.waitForSelector(".nav-picker", {
      strategy: "pierce",
    });

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
      const el = await page.waitForSelector(".nav-picker", {
        strategy: "pierce",
      });
      const val = await el.evaluate(
        (e: Element) => e.getAttribute("aria-expanded"),
      );
      return val === "true";
    });
  });

  it("menu panel has role=menu and items have role=menuitem", async () => {
    const page = shell.page();
    await loginAndGoto();

    // Open the menu
    const trigger = await page.waitForSelector(".nav-picker", {
      strategy: "pierce",
    });
    await trigger.click();

    await waitFor(async () => {
      const el = await page.waitForSelector(".menu-container", {
        strategy: "pierce",
      });
      const cls = await el.evaluate((e: Element) => e.className);
      return cls.includes("open");
    });

    // Check role=menu on panel
    const panel = await page.waitForSelector(".menu-panel", {
      strategy: "pierce",
    });
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

    // Open menu at space root — should show "Go Home"
    const trigger = await page.waitForSelector(".nav-picker", {
      strategy: "pierce",
    });
    await trigger.click();

    await waitFor(async () => {
      const el = await page.waitForSelector(".menu-container", {
        strategy: "pierce",
      });
      const cls = await el.evaluate((e: Element) => e.className);
      return cls.includes("open");
    });

    await waitFor(async () => {
      try {
        const items = await page.waitForSelector(
          '[role="menuitem"] .menu-item-label',
          { strategy: "pierce", timeout: 500 },
        );
        const text = await items.innerText();
        return text?.trim() === "Go Home";
      } catch {
        return false;
      }
    });
  });
});
