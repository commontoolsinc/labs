/**
 * Integration tests for ct-code-editor cursor stability.
 *
 * Tests that the cursor doesn't jump when:
 * 1. Typing normally (Cell echoes back after debounce)
 * 2. Rapid typing with debounce window
 * 3. External Cell updates during typing
 *
 * The critical flow being tested:
 * - User types → editor updates → hash stored → debounced Cell update (500ms)
 * - Cell echo fires → hash compared → if match, skip update → cursor stays
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

// Debounce delay configured in ct-code-editor (default timingDelay)
const DEBOUNCE_DELAY = 500;
const DEBOUNCE_BUFFER = 100; // Extra time for processing

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

  it("should maintain cursor position during normal typing with Cell echo", async () => {
    const page = shell.page();

    // Focus the editor
    const editor = await page.waitForSelector("ct-code-editor", {
      strategy: "pierce",
    });
    await focusEditor(page);

    // Verify editor is empty initially
    const initialContent = await getEditorContent(page);
    assertEquals(initialContent, "", "Editor should start empty");

    // Type text using keyboard simulation (NOT charm.result.set)
    const textToType = "Hello World";
    await typeInEditor(page, textToType);

    // Verify cursor position immediately after typing (before debounce)
    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(
      cursorAfterTyping,
      textToType.length,
      "Cursor should be at end after typing",
    );

    // Verify content is in editor
    const contentBeforeDebounce = await getEditorContent(page);
    assertEquals(contentBeforeDebounce, textToType);

    // Wait for debounce to complete and Cell to update
    await waitFor(
      async () => {
        const cellValue = charm.result.get(["content"]);
        return cellValue === textToType;
      },
      { timeout: DEBOUNCE_DELAY + 1000, interval: 50 },
    );

    // Wait a bit more for any Cell echo to propagate back
    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    // Critical test: cursor should NOT have jumped after Cell echo
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      textToType.length,
      "Cursor should remain at end after Cell echo (NOT jump to 0)",
    );

    // Content should still be correct
    const finalContent = await getEditorContent(page);
    assertEquals(finalContent, textToType);
  });

  it("should maintain cursor during rapid typing (multiple chars in debounce window)", async () => {
    const page = shell.page();

    // Clear the editor first
    await clearEditor(page);
    await waitFor(
      async () => {
        const cellValue = charm.result.get(["content"]);
        return cellValue === "";
      },
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    await focusEditor(page);

    // Type several characters rapidly (within debounce window)
    // Each character typed resets the debounce timer
    const chars = ["A", "B", "C", "D", "E"];
    for (const char of chars) {
      await page.keyboard.type(char);
      // Small delay between chars but less than debounce
      await new Promise((r) => setTimeout(r, 50));
    }

    const fullText = chars.join("");

    // Verify cursor is at end immediately
    const cursorBeforeDebounce = await getCursorPosition(page);
    assertEquals(cursorBeforeDebounce, fullText.length);

    // Wait for debounce to complete (only fires ONCE after last character)
    await waitFor(
      async () => {
        const cellValue = charm.result.get(["content"]);
        return cellValue === fullText;
      },
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    // Cursor should still be at end, not jumped
    const cursorAfterDebounce = await getCursorPosition(page);
    assertEquals(
      cursorAfterDebounce,
      fullText.length,
      "Cursor should not jump during rapid typing",
    );
  });

  it("should maintain cursor when typing mid-document", async () => {
    const page = shell.page();

    // Set initial content
    await clearEditor(page);
    const initialText = "Start End";
    await typeInEditor(page, initialText);

    // Wait for Cell to sync
    await waitFor(
      async () => charm.result.get(["content"]) === initialText,
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    // Move cursor to middle (after "Start ")
    const middlePos = 6; // After "Start "
    await setCursorPosition(page, middlePos);

    const cursorAtMiddle = await getCursorPosition(page);
    assertEquals(cursorAtMiddle, middlePos, "Cursor should be at middle");

    // Type in the middle
    await page.keyboard.type("MIDDLE ");

    const expectedText = "Start MIDDLE End";
    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(
      cursorAfterTyping,
      13,
      "Cursor should be after inserted text",
    ); // "Start MIDDLE ".length

    // Wait for debounce
    await waitFor(
      async () => charm.result.get(["content"]) === expectedText,
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    // Cursor should stay where it was after typing
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      13,
      "Cursor should not jump to end or 0 after Cell echo",
    );
  });

  it("should handle external Cell update during debounce window", async () => {
    const page = shell.page();

    await clearEditor(page);
    await waitFor(
      async () => charm.result.get(["content"]) === "",
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    await focusEditor(page);

    // Start typing
    await page.keyboard.type("User");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 4);

    // BEFORE debounce completes, simulate external update
    // This simulates another user/process updating the Cell
    await new Promise((r) => setTimeout(r, 200)); // Partway through debounce
    await charm.result.set("External Update", ["content"]);

    // Wait for external update to propagate to editor
    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === "External Update";
      },
      { timeout: 1000 },
    );

    // The cursor should be clamped to valid range (not beyond content length)
    const cursorAfterExternal = await getCursorPosition(page);
    const finalContent = await getEditorContent(page);
    assert(
      cursorAfterExternal >= 0 && cursorAfterExternal <= finalContent.length,
      `Cursor should be in valid range [0, ${finalContent.length}], got ${cursorAfterExternal}`,
    );

    // The pending debounced update of "User" should not override the external update
    // Wait to ensure no race condition
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + DEBOUNCE_BUFFER));

    const cellValue = charm.result.get(["content"]);
    assertEquals(
      cellValue,
      "External Update",
      "External update should persist (not overwritten by stale debounced update)",
    );
  });

  it("should clamp cursor when external update shortens content", async () => {
    const page = shell.page();

    // Set long content
    const longContent = "This is a very long piece of content that will be shortened";
    await charm.result.set(longContent, ["content"]);

    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === longContent;
      },
      { timeout: 1000 },
    );

    // Move cursor to end
    await focusEditor(page);
    await setCursorPosition(page, longContent.length);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, longContent.length);

    // External update shortens content drastically
    const shortContent = "Short";
    await charm.result.set(shortContent, ["content"]);

    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === shortContent;
      },
      { timeout: 1000 },
    );

    // Cursor should be clamped to new content length
    const cursorAfterShorten = await getCursorPosition(page);
    assert(
      cursorAfterShorten >= 0 && cursorAfterShorten <= shortContent.length,
      `Cursor should be clamped to [0, ${shortContent.length}], got ${cursorAfterShorten}`,
    );
  });

  it("should not apply Cell echo if content hash matches (own change)", async () => {
    const page = shell.page();

    await clearEditor(page);
    await waitFor(
      async () => charm.result.get(["content"]) === "",
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    await focusEditor(page);

    // Type text
    const text = "Test echo detection";
    await typeInEditor(page, text);

    const cursorBeforeEcho = await getCursorPosition(page);
    assertEquals(cursorBeforeEcho, text.length);

    // Wait for debounce to fire and Cell to update
    await waitFor(
      async () => charm.result.get(["content"]) === text,
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    // The Cell echo should be detected and skipped (hash match)
    // Cursor should NOT move
    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      text.length,
      "Cursor should not move when Cell echo is detected (hash match)",
    );

    // Now simulate EXTERNAL change with different content
    await charm.result.set("Different content", ["content"]);

    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === "Different content";
      },
      { timeout: 1000 },
    );

    // This should apply because hash doesn't match (external change)
    const finalContent = await getEditorContent(page);
    assertEquals(finalContent, "Different content");
  });

  it("should handle backspace and maintain cursor", async () => {
    const page = shell.page();

    await clearEditor(page);
    await focusEditor(page);

    // Type some text
    await typeInEditor(page, "Hello World");
    await waitFor(
      async () => charm.result.get(["content"]) === "Hello World",
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    // Backspace several times
    for (let i = 0; i < 6; i++) {
      // Delete " World"
      await page.keyboard.press("Backspace");
      await new Promise((r) => setTimeout(r, 50));
    }

    const expectedText = "Hello";
    const cursorAfterBackspace = await getCursorPosition(page);
    assertEquals(cursorAfterBackspace, expectedText.length);

    // Wait for debounce
    await waitFor(
      async () => charm.result.get(["content"]) === expectedText,
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    // Cursor should still be at correct position
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(cursorAfterEcho, expectedText.length);
  });
});

/**
 * Get current cursor position in the ct-code-editor
 */
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

/**
 * Get current content from the ct-code-editor
 */
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

/**
 * Focus the CodeMirror editor by clicking on the content area
 */
async function focusEditor(page: Page): Promise<void> {
  await page.evaluate(`
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
      if (ctEditor && ctEditor._editorView) {
        ctEditor._editorView.focus();
      }
    })()
  `);
}

/**
 * Type text into the editor using keyboard simulation
 * This properly triggers the typing flow with debounce
 */
async function typeInEditor(page: Page, text: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.type(text);
}

/**
 * Set cursor position in the editor
 */
async function setCursorPosition(page: Page, position: number): Promise<void> {
  await page.evaluate(`
    ((pos) => {
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
      if (ctEditor && ctEditor._editorView) {
        ctEditor._editorView.dispatch({
          selection: { anchor: pos, head: pos }
        });
      }
    })(${position})
  `);
}

/**
 * Clear the editor content
 */
async function clearEditor(page: Page): Promise<void> {
  await page.evaluate(`
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
      if (ctEditor && ctEditor._editorView) {
        const view = ctEditor._editorView;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" }
        });
      }
    })()
  `);
}
