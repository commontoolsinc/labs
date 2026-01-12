import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { assert } from "@std/assert";
import { sleep } from "@commontools/utils/sleep";

const { FRONTEND_URL } = env;

describe("default-app flow test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let spaceName: string;

  it("should create a note via default app and see it in the space list", async () => {
    // Generate a unique space name
    spaceName = `test-space-${crypto.randomUUID()}`;
    identity = await Identity.generate({ implementation: "noble" });

    const page = shell.page();

    // Navigate directly to the new space (no charm creation via ct tools)
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
      identity,
    });

    // Helper to find and click a button by text using piercing selectors
    const clickButtonWithText = async (
      searchText: string,
    ): Promise<boolean> => {
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
        // Also check x-charm-link elements
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
    };

    // Helper to check if text exists in the DOM using waitForFunction
    const textExistsInDom = async (searchText: string): Promise<boolean> => {
      try {
        // Use page.evaluate to search text in shadow DOM
        return await page.evaluate((text: string) => {
          function searchShadowDom(root: Document | ShadowRoot): boolean {
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_TEXT,
              null,
            );
            let node;
            while ((node = walker.nextNode())) {
              if (node.textContent?.includes(text)) {
                return true;
              }
            }
            const elements = root.querySelectorAll("*");
            for (const el of elements) {
              if (el.shadowRoot) {
                if (searchShadowDom(el.shadowRoot)) {
                  return true;
                }
              }
            }
            return false;
          }
          return searchShadowDom(document);
        }, { args: [searchText] });
      } catch (_) {
        return false;
      }
    };

    // Wait for "Notes" dropdown button to appear and click it
    await waitFor(async () => {
      return await clickButtonWithText("Notes");
    });

    // Wait for dropdown to open and click "New Note"
    await waitFor(async () => {
      return await clickButtonWithText("New Note");
    });

    // Wait for the note page to load by checking for the note title
    await waitFor(async () => {
      return await textExistsInDom("📝 New Note");
    });

    // Wait for the note to be fully persisted
    // Note: We don't have persistence hooks to wait on, so use a sleep
    await sleep(3000);

    // Navigate back to the space list
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
      identity,
    });

    // Wait for the list content to fully load (look for Patterns heading)
    await waitFor(async () => {
      return await textExistsInDom("Patterns");
    });

    // Helper to find note in list using regex pattern
    const findNoteInList = async (): Promise<boolean> => {
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
    };

    // Check that the list contains a note item
    await waitFor(findNoteInList);

    // Final assertion using the same helper
    const noteFound = await findNoteInList();
    assert(
      noteFound,
      "List should contain '📝 New Note #<hash>' after creating a note",
    );
  });
});
