import { env, Page, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { assert } from "@std/assert";

const { FRONTEND_URL } = env;

describe("default-app flow test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  const spaceName = `test-space-${randomUUID()}`;

  it("should create a note via default app and see it in the space list", async () => {
    identity = await Identity.generate({ implementation: "noble" });

    const page = shell.page();

    // Navigate directly to the new space (no piece creation via ct tools)
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
      identity,
    });

    // Wait for "Notes" dropdown button to appear and click it
    console.log("Click notes drop down...");
    await waitFor(async () => {
      return await clickButtonWithText(page, "Notes");
    });

    // Wait for dropdown to open and click "New Note"
    console.log("Click 'New Note'...");
    await waitFor(async () => {
      return await clickButtonWithText(page, "New Note");
    });

    // Wait for the note page to load by checking for the note title
    console.log("Look for '📝 New Note'...");
    await waitFor(async () => {
      const link = await page.waitForSelector("#header-piece-link", {
        strategy: "pierce",
      });
      const innerText = await link.innerText();
      return innerText === "📝 New Note";
    });

    // Navigate back to the space page and wait for new note to appear
    console.log("Navigate back to space page...");
    await waitFor(async () => {
      return await clickButtonWithText(page, spaceName);
    });

    // Check that the list contains a note item
    console.log("Wait for note in list...");
    await waitFor(() => findNoteInList(page));

    // Final assertion using the same helper
    const noteFound = await findNoteInList(page);
    assert(
      noteFound,
      "List should contain '📝 New Note #<hash>' after creating a note",
    );
  });
});

// Helper to find and click a button by text using piercing selectors
async function clickButtonWithText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  try {
    // Search ct-button, button, and a elements with piercing selector
    const buttons = await page.$$("ct-button, button, a", {
      strategy: "pierce",
    });
    for (const button of buttons) {
      const text = await button.innerText();
      if (text?.trim().includes(searchText)) {
        await button.click();
        return true;
      }
    }
    // Also check x-charm-link elements (custom element name not renamed)
    const links = await page.$$("x-charm-link", { strategy: "pierce" });
    for (const link of links) {
      const text = await link.innerText();
      if (text?.trim().includes(searchText)) {
        await link.click();
        return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

// Helper to find note in list using regex pattern
async function findNoteInList(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      function search(root: Document | ShadowRoot): boolean {
        const allElements = root.querySelectorAll("*");
        for (const el of allElements) {
          const text = el.textContent;
          // Match pattern: emoji + "New Note #" + hash chars
          if (text && /📝 New Note #[a-z0-9]+/.test(text)) {
            return true;
          }
          if (el.shadowRoot) {
            if (search(el.shadowRoot)) {
              return true;
            }
          }
        }
        return false;
      }
      return search(document);
    });
  } catch (_) {
    return false;
  }
}
