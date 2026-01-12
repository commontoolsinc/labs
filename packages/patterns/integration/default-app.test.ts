import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { assert } from "@std/assert";

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

    // Helper to find and click a button/link by text (searching through shadow DOM)
    // Looks for CT-BUTTON, BUTTON, A, and X-CHARM-LINK elements
    const clickButtonWithText = async (
      searchText: string,
    ): Promise<boolean> => {
      return await page.evaluate((text: string) => {
        function findInShadow(root: Document | ShadowRoot): boolean {
          const allElements = root.querySelectorAll("*");
          for (const el of allElements) {
            // Look for clickable elements with matching text
            const tagName = el.tagName;
            if (
              (tagName === "CT-BUTTON" || tagName === "BUTTON" ||
                tagName === "A") &&
              el.textContent?.trim().includes(text)
            ) {
              (el as HTMLElement).click();
              return true;
            }
            // X-CHARM-LINK has a shadow root with an A inside - click the A
            if (
              tagName === "X-CHARM-LINK" &&
              el.textContent?.trim().includes(text)
            ) {
              const shadowRoot = el.shadowRoot;
              if (shadowRoot) {
                const anchor = shadowRoot.querySelector("a");
                if (anchor) {
                  anchor.click();
                  return true;
                }
              }
              // Fallback to clicking the element itself
              (el as HTMLElement).click();
              return true;
            }
            // Recurse into shadow roots
            if (el.shadowRoot) {
              if (findInShadow(el.shadowRoot)) {
                return true;
              }
            }
          }
          return false;
        }
        return findInShadow(document);
      }, { args: [searchText] });
    };

    // Helper to check if text exists in the DOM (searching through shadow DOM)
    const textExistsInDom = async (searchText: string): Promise<boolean> => {
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
    await new Promise((resolve) => setTimeout(resolve, 3000));

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

    // Check that the list contains a note item (look for hash pattern indicating list item)
    await waitFor(async () => {
      const found = await page.evaluate(() => {
        function findNoteInList(root: Document | ShadowRoot): boolean {
          const allElements = root.querySelectorAll("*");
          for (const el of allElements) {
            const text = el.textContent;
            // Match pattern: emoji + "New Note #" + hash chars
            if (text && /📝 New Note #[a-z0-9]+/.test(text)) {
              return true;
            }
            if (el.shadowRoot) {
              if (findNoteInList(el.shadowRoot)) {
                return true;
              }
            }
          }
          return false;
        }
        return findNoteInList(document);
      });
      return found;
    });

    // Final assertion
    const noteFound = await page.evaluate(() => {
      function findNoteInList(root: Document | ShadowRoot): boolean {
        const allElements = root.querySelectorAll("*");
        for (const el of allElements) {
          const text = el.textContent;
          if (text && /📝 New Note #[a-z0-9]+/.test(text)) {
            return true;
          }
          if (el.shadowRoot) {
            if (findNoteInList(el.shadowRoot)) {
              return true;
            }
          }
        }
        return false;
      }
      return findNoteInList(document);
    });
    assert(
      noteFound,
      "List should contain '📝 New Note #<hash>' after creating a note",
    );
  });
});
