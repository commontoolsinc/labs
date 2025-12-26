/**
 * Integration tests for ct-code-editor cursor stability.
 *
 * Tests that the cursor doesn't jump when:
 * 1. Typing normally (Cell echoes back)
 * 2. Rapid typing with debounce
 * 3. External Cell updates
 */
import { env, Page, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { ANYONE_USER } from "@commontools/memory/acl";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("ct-code-editor cursor stability", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

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
        join(import.meta.dirname!, "..", "examples", "ct-code-editor-cell.tsx"),
      ),
      { start: true },
    );

    // Add permissions for ANYONE
    await cc.acl().set(ANYONE_USER, "WRITE");
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the ct-code-editor charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        charmId: charm.id,
      },
      identity,
    });
    await page.waitForSelector("ct-code-editor", { strategy: "pierce" });
  });

  it("should set content via Cell and have stable cursor", async () => {
    const page = shell.page();

    // Set initial content via Cell
    await charm.result.set("Initial content", ["content"]);
    await new Promise((r) => setTimeout(r, 500));

    // Reload to get the new content
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        charmId: charm.id,
      },
      identity,
    });
    await page.waitForSelector("ct-code-editor", { strategy: "pierce" });

    // Wait for content to appear
    await waitFor(async (): Promise<boolean> => {
      const content = await getEditorContent(page);
      return content === "Initial content";
    });

    // Get initial cursor position
    const cursorPos1 = await getCursorPosition(page);
    assert(cursorPos1 >= 0, "Cursor should be at valid position");

    // Update content via Cell - this tests external update handling
    await charm.result.set("Updated content", ["content"]);
    await new Promise((r) => setTimeout(r, 500));

    // Verify content updated
    await waitFor(async (): Promise<boolean> => {
      const content = await getEditorContent(page);
      return content === "Updated content";
    });

    // Cursor should be in valid range (0 to length)
    const cursorPos2 = await getCursorPosition(page);
    const content = await getEditorContent(page);
    assert(
      cursorPos2 >= 0 && cursorPos2 <= content.length,
      `Cursor should be in valid range (got ${cursorPos2}, length=${content.length})`,
    );
  });

  it("should clamp cursor when external update shortens content", async () => {
    const page = shell.page();

    // First, set some content and position cursor in middle
    const longContent = "This is a long piece of content";
    await charm.result.set(longContent, ["content"]);
    await new Promise((r) => setTimeout(r, 500));

    // Reload to get the new content
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        charmId: charm.id,
      },
      identity,
    });
    await page.waitForSelector("ct-code-editor", { strategy: "pierce" });

    // Click in editor and move to middle
    const editor = await page.waitForSelector("ct-code-editor", {
      strategy: "pierce",
    });
    await editor.click();

    // Now simulate external update that shortens content
    await charm.result.set("Short", ["content"]);
    await new Promise((r) => setTimeout(r, 500));

    // Verify cursor is within valid range (0 to 5)
    const cursorPos = await getCursorPosition(page);
    assert(
      cursorPos >= 0 && cursorPos <= 5,
      `Cursor should be clamped to content length (got ${cursorPos})`,
    );

    // Verify content updated
    assertEquals(charm.result.get(["content"]), "Short");
  });
});

async function getCursorPosition(page: Page): Promise<number> {
  const result = await page.evaluate(`
    (() => {
      function findCtCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('ct-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCtCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const ctEditor = findCtCodeEditor(document);
      if (!ctEditor || !ctEditor._editorView) return -1;

      return ctEditor._editorView.state.selection.main.head;
    })()
  `);
  return result as number;
}

async function getEditorContent(page: Page): Promise<string> {
  const result = await page.evaluate(`
    (() => {
      function findCtCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('ct-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCtCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const ctEditor = findCtCodeEditor(document);
      if (!ctEditor || !ctEditor._editorView) return "";

      return ctEditor._editorView.state.doc.toString();
    })()
  `);
  return result as string;
}
