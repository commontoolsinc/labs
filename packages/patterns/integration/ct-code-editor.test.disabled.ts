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
import { PieceController, PiecesController } from "@commontools/piece/ops";
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
  let cc: PiecesController;
  let piece: PieceController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    piece = await cc.create(
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

  it("should load the ct-code-editor piece", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });
    await page.waitForSelector("ct-code-editor", { strategy: "pierce" });
    await new Promise((r) => setTimeout(r, 1000));
  });

  it("should sync Cell value to editor", async () => {
    const page = shell.page();
    const text = "initial";

    // Clear any initial state first and wait for editor to show empty
    await clearEditor(page);

    // Set Cell value
    await piece.result.set(text, ["content"]);

    // Wait for editor to reflect it
    await waitFor(
      async () => (await getEditorContent(page)) === text,
      { timeout: 3000, delay: 50 },
    );

    // Short delay
    await new Promise((r) => setTimeout(r, 300));

    // Clear for next test
    await piece.result.set("", ["content"]);
    await waitFor(
      async () => (await getEditorContent(page)) === "",
      { timeout: 5000, delay: 50 },
    );
  });

  it("should maintain cursor position during normal typing with Cell echo", async () => {
    const page = shell.page();

    // Clear any initial state first and wait for editor to show empty
    await clearEditor(page);
    // Also set Cell to empty to ensure sync
    await piece.result.set("", ["content"]);

    // Wait for both editor and Cell to be empty and synchronized
    await waitFor(
      async () => {
        const editorContent = await getEditorContent(page);
        const cellValue = await piece.result.get(["content"]);
        return editorContent === "" && cellValue === "";
      },
    );

    // Extra settling time for any pending Cell subscription callbacks to drain.
    // This is critical because shared piece between tests can have stale
    // subscription callbacks queued that fire after we start typing.
    await new Promise((r) => setTimeout(r, 300));

    // Focus the editor
    await focusEditor(page);

    // Verify editor is empty initially
    const initialContent = await getEditorContent(page);
    assertEquals(initialContent, "", "Editor should start empty");

    // Type text using keyboard simulation (NOT piece.result.set)
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
      async () => await piece.result.get(["content"]) === textToType,
    );

    // Wait for the Cell echo to propagate and confirm cursor stays stable.
    // We poll multiple times to ensure cursor doesn't jump transiently.
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

    // Clear the editor first and sync Cell to empty
    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

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
      async () => await piece.result.get(["content"]) === fullText,
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
      async () => await piece.result.get(["content"]) === initialText,
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
      async () => await piece.result.get(["content"]) === expectedText,
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

  it("should apply external Cell update during debounce window", async () => {
    const page = shell.page();

    // Clear the editor and sync Cell to empty
    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Start typing
    await page.keyboard.type("User");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 4);

    // BEFORE debounce completes, simulate external update
    // This simulates another user/process updating the Cell
    await new Promise((r) => setTimeout(r, 200)); // Partway through debounce
    await piece.result.set("External Update", ["content"]);

    // Wait a moment for the external update to potentially propagate
    await new Promise((r) => setTimeout(r, 100));

    // External updates override local edits, even during debounce.
    const contentDuringDebounce = await getEditorContent(page);
    assertEquals(
      contentDuringDebounce,
      "External Update",
      "Editor should apply external update during debounce",
    );

    // Cursor should be clamped, not invalid
    const cursorDuringDebounce = await getCursorPosition(page);
    assertEquals(
      cursorDuringDebounce,
      4,
      "Cursor should remain valid after external update",
    );

    // Wait for debounce to complete - pending local write was canceled
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + DEBOUNCE_BUFFER));

    // After debounce, the Cell should still have the external update
    const cellValue = await piece.result.get(["content"]);
    assertEquals(
      cellValue,
      "External Update",
      "External update should remain after canceling local debounce",
    );
  });

  it("should apply external update when no typing is in progress", async () => {
    // This test verifies that external updates are applied when the user
    // is NOT actively typing (no debounce window active). Also tests
    // cursor clamping when content is shortened.
    const page = shell.page();

    // Clear editor state from previous tests and sync Cell to empty
    await clearEditor(page);
    await piece.result.set("", ["content"]);
    // Allow time for any pending Cell subscription callbacks
    await new Promise((r) => setTimeout(r, 300));

    // Set long content externally (no typing, no hash stored)
    const longContent =
      "This is a very long piece of content that will be shortened";
    await piece.result.set(longContent, ["content"]);

    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === longContent;
      },
    );

    // Move cursor to end (still no typing)
    await focusEditor(page);
    await setCursorPosition(page, longContent.length);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, longContent.length);

    // External update shortens content drastically
    // Since no typing is in progress, this should apply immediately
    const shortContent = "Short";
    await piece.result.set(shortContent, ["content"]);

    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === shortContent;
      },
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

    // Clear the editor and sync Cell to empty
    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type text
    const text = "Test echo detection";
    await typeInEditor(page, text);

    const cursorBeforeEcho = await getCursorPosition(page);
    assertEquals(cursorBeforeEcho, text.length);

    // Wait for debounce to fire and Cell to update
    await waitFor(
      async () => await piece.result.get(["content"]) === text,
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
    await piece.result.set("Different content", ["content"]);

    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === "Different content";
      },
    );

    // This should apply because hash doesn't match (external change)
    const finalContent = await getEditorContent(page);
    assertEquals(finalContent, "Different content");
  });

  it("should handle backspace and maintain cursor", async () => {
    const page = shell.page();

    // Clear the editor and sync Cell to empty
    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type some text
    await typeInEditor(page, "Hello World");
    await waitFor(
      async () => await piece.result.get(["content"]) === "Hello World",
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
      async () => await piece.result.get(["content"]) === expectedText,
    );

    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    // Cursor should still be at correct position
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(cursorAfterEcho, expectedText.length);
  });

  // ==========================================================================
  // NEGATIVE TESTS: Verify cursor DOES move when it should
  // ==========================================================================

  it("should apply external update and move cursor after editor blur", async () => {
    // This is a NEGATIVE test: cursor SHOULD move when user is not actively editing
    const page = shell.page();

    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type and wait for sync
    await typeInEditor(page, "Hello World");
    await waitFor(
      async () => await piece.result.get(["content"]) === "Hello World",
    );

    // Blur the editor - this should allow external updates to apply
    await page.evaluate(`
      (() => {
        const active = document.activeElement;
        if (active && active.blur) active.blur();
      })()
    `);
    await new Promise((r) => setTimeout(r, 100));

    // External update with shorter content
    await piece.result.set("Short", ["content"]);

    // Wait for external update to apply
    await waitFor(
      async () => (await getEditorContent(page)) === "Short",
    );

    // Cursor should be clamped to new content length (not stuck at old position)
    const cursor = await getCursorPosition(page);
    assert(
      cursor >= 0 && cursor <= "Short".length,
      `Cursor should be clamped to [0, 5], got ${cursor}`,
    );
  });

  it("should apply external update after debounce window fully expires", async () => {
    // After debounce completes and hash is cleared, external updates should apply
    const page = shell.page();

    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type and wait for debounce to complete
    await typeInEditor(page, "User typed");
    await waitFor(
      async () => await piece.result.get(["content"]) === "User typed",
    );

    // Wait extra time to ensure hash is fully cleared
    await new Promise((r) => setTimeout(r, 200));

    // Now external update should apply (no hash blocking it)
    await piece.result.set("External update", ["content"]);

    await waitFor(
      async () => (await getEditorContent(page)) === "External update",
    );

    const content = await getEditorContent(page);
    assertEquals(content, "External update");
  });

  // ==========================================================================
  // STRESS TESTS: Edge cases and rapid operations
  // ==========================================================================

  it("should handle multiple rapid external updates correctly", async () => {
    // Stress test: rapid Cell updates should all apply correctly
    const page = shell.page();

    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    // Send 5 external updates rapidly (no user typing)
    for (let i = 0; i < 5; i++) {
      await piece.result.set(`Update ${i}`, ["content"]);
      await new Promise((r) => setTimeout(r, 50));
    }

    // Final content should be last update
    await waitFor(
      async () => (await getEditorContent(page)) === "Update 4",
    );

    // Cursor should be valid
    const cursor = await getCursorPosition(page);
    assert(
      cursor >= 0 && cursor <= "Update 4".length,
      `Cursor should be valid, got ${cursor}`,
    );
  });

  it("should handle undo operation and maintain correct state", async () => {
    // Undo triggers updateListener - verify hash doesn't cause issues
    const page = shell.page();

    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type initial text
    await typeInEditor(page, "Hello");
    await waitFor(
      async () => await piece.result.get(["content"]) === "Hello",
    );

    // Type more text
    await typeInEditor(page, " World");
    await waitFor(
      async () => await piece.result.get(["content"]) === "Hello World",
    );

    // Undo (Cmd+Z on Mac, Ctrl+Z on others)
    const isMac = await page.evaluate(`navigator.platform.includes('Mac')`);
    if (isMac) {
      await page.keyboard.down("Meta");
      await page.keyboard.press("z");
      await page.keyboard.up("Meta");
    } else {
      await page.keyboard.down("Control");
      await page.keyboard.press("z");
      await page.keyboard.up("Control");
    }

    await new Promise((r) => setTimeout(r, 100));

    // After undo, editor should show previous state
    const contentAfterUndo = await getEditorContent(page);
    // Note: Undo behavior depends on CodeMirror's history - content may vary
    // The key test is that cursor is valid and no crash occurs
    const cursorAfterUndo = await getCursorPosition(page);
    assert(
      cursorAfterUndo >= 0 && cursorAfterUndo <= contentAfterUndo.length,
      `Cursor should be valid after undo, got ${cursorAfterUndo}`,
    );

    // Wait for any Cell sync from undo
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + 200));

    // Verify editor and Cell are in sync
    const finalContent = await getEditorContent(page);
    const cellValue = await piece.result.get(["content"]);
    assertEquals(
      finalContent,
      cellValue,
      "Editor and Cell should be in sync after undo",
    );
  });

  it("should handle text selection (anchor != head) during external update", async () => {
    // Test that selections are preserved/clamped correctly
    const page = shell.page();

    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    // Set initial content externally
    await piece.result.set("Hello World Test", ["content"]);
    await waitFor(
      async () => (await getEditorContent(page)) === "Hello World Test",
    );

    await focusEditor(page);

    // Select "World" (positions 6-11)
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
          ctEditor._editorView.dispatch({
            selection: { anchor: 6, head: 11 }
          });
        }
      })()
    `);

    // Verify selection
    const selection = (await page.evaluate(`
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
        if (!ctEditor || !ctEditor._editorView) return null;
        const sel = ctEditor._editorView.state.selection.main;
        return { anchor: sel.anchor, head: sel.head };
      })()
    `)) as { anchor: number; head: number };
    assertEquals(selection.anchor, 6);
    assertEquals(selection.head, 11);

    // External update with shorter content - selection should be clamped
    await piece.result.set("Hi", ["content"]);
    await waitFor(
      async () => (await getEditorContent(page)) === "Hi",
    );

    // Selection should be clamped to new content length
    const clampedSelection = (await page.evaluate(`
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
        if (!ctEditor || !ctEditor._editorView) return null;
        const sel = ctEditor._editorView.state.selection.main;
        return { anchor: sel.anchor, head: sel.head };
      })()
    `)) as { anchor: number; head: number };

    assert(
      clampedSelection.anchor >= 0 && clampedSelection.anchor <= 2,
      `Anchor should be clamped to [0, 2], got ${clampedSelection.anchor}`,
    );
    assert(
      clampedSelection.head >= 0 && clampedSelection.head <= 2,
      `Head should be clamped to [0, 2], got ${clampedSelection.head}`,
    );
  });

  // ==========================================================================
  // ADVERSARIAL TESTS: Race conditions, timing attacks, edge cases
  // ==========================================================================

  it("ADVERSARIAL: Cell update at exact debounce boundary should not corrupt state", async () => {
    // This tests the race condition where a Cell update arrives exactly
    // when the debounce timer fires. The fix should handle this gracefully.
    const page = shell.page();

    await resetEditorState(page, piece);

    await focusEditor(page);

    // Type some text
    await page.keyboard.type("Test");

    // Wait for ALMOST the full debounce window (490ms of 500ms)
    await new Promise((r) => setTimeout(r, 490));

    // Send external update at the boundary
    await piece.result.set("External at boundary", ["content"]);

    // Let the race play out
    await new Promise((r) => setTimeout(r, 200));

    // After settling, editor and Cell should match
    await waitFor(
      async () => {
        const e = await getEditorContent(page);
        const c = await piece.result.get(["content"]);
        return e === c;
      },
    );

    // Cursor should be valid
    const cursor = await getCursorPosition(page);
    const finalContent = await getEditorContent(page);
    assert(
      cursor >= 0 && cursor <= finalContent.length,
      `Cursor ${cursor} should be valid for content length ${finalContent.length}`,
    );
  });

  it("ADVERSARIAL: Rapid alternating type-Cell-type-Cell pattern", async () => {
    // Simulates a pathological case: user types, Cell updates, user types again
    // repeatedly. This can expose issues with timestamp tracking.
    //
    // CORRECT BEHAVIOR: External Cell updates override local edits when they
    // arrive. Local edits after the last external update will be committed.
    const page = shell.page();

    await resetEditorState(page, piece);

    await focusEditor(page);

    // Alternating pattern: type → Cell → type → Cell → type
    for (let i = 0; i < 3; i++) {
      // Type a character
      await page.keyboard.type(`${i}`);

      // Small delay to ensure typing is registered
      await new Promise((r) => setTimeout(r, 50));

      // Send Cell update (different content to force conflict)
      // This should override the current editor content
      await piece.result.set(`External-${i}`, ["content"]);

      // Another small delay
      await new Promise((r) => setTimeout(r, 100));
    }

    // Let things settle - user's typed content should win
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + 300));

    // Editor should be in a consistent state
    const content = await getEditorContent(page);
    const cursor = await getCursorPosition(page);

    assert(
      cursor >= 0 && cursor <= content.length,
      `Cursor ${cursor} should be valid for content length ${content.length}`,
    );

    const cellValue = await piece.result.get(["content"]) as string;
    assertEquals(
      content,
      cellValue,
      "Editor and Cell should be in sync after settling",
    );

    // The final value should be the last external update
    assertEquals(
      content,
      "External-2",
      "External update should override local edits in alternating pattern",
    );
  });

  it("ADVERSARIAL: Multiple Cell updates while user is continuously typing", async () => {
    // User types continuously (letters every 50ms) while external updates
    // bombard the Cell. The editor should not corrupt or crash.
    //
    // CORRECT BEHAVIOR: External updates override current content when they
    // arrive. Any typing after the final external update is appended and
    // committed after debounce.
    const page = shell.page();

    await resetEditorState(page, piece);

    await focusEditor(page);

    // Start typing in the background (simulated)
    const typingPromise = (async () => {
      for (let i = 0; i < 10; i++) {
        await page.keyboard.type(String.fromCharCode(65 + i)); // A, B, C...
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    // Bombard with Cell updates concurrently
    const cellBombardPromise = (async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 80));
        await piece.result.set(`Bombard-${i}`, ["content"]);
      }
    })();

    // Wait for both to complete
    await Promise.all([typingPromise, cellBombardPromise]);

    // Let debounce complete
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + 300));

    // Final state should be consistent
    const content = await getEditorContent(page);
    const cursor = await getCursorPosition(page);
    const cellValue = await piece.result.get(["content"]) as string;

    // Cursor must be valid
    assert(
      cursor >= 0 && cursor <= content.length,
      `Cursor ${cursor} should be valid for content length ${content.length}`,
    );

    // Editor and Cell should be in sync
    assertEquals(
      content,
      cellValue,
      "Editor and Cell should be in sync after chaos",
    );

    assert(
      content.startsWith("Bombard-4"),
      "Final content should include last external update",
    );
  });

  it("ADVERSARIAL: Empty string Cell update during typing", async () => {
    // Edge case: Cell is set to empty while user is typing.
    // This can cause cursor position > content length if not handled.
    //
    // ACTUAL BEHAVIOR: If the external update does not change stored value
    // (Cell still empty because debounce hasn't committed), no sink fires.
    // User typing continues uninterrupted and eventually commits.
    // The key invariants to test:
    // 1. Cursor remains valid (no crashes from cursor > content.length)
    // 2. Editor and Cell are eventually consistent
    // 3. Content matches one of the valid states (empty or user's content)
    const page = shell.page();

    await resetEditorState(page, piece);

    await focusEditor(page);

    // Type some content
    await page.keyboard.type("Hello World");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 11);

    // Immediately try to clear via Cell (within debounce window)
    await piece.result.set("", ["content"]);

    // Wait a bit but not full debounce
    await new Promise((r) => setTimeout(r, 100));

    // User continues typing - editor now has "Hello WorldMore"
    // This triggers setValue which will overwrite the Cell's ""
    await page.keyboard.type("More");

    // Let everything settle
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + 300));

    const finalContent = await getEditorContent(page);
    const cursor = await getCursorPosition(page);

    // CRITICAL: Cursor must be valid (no crash)
    assert(
      cursor >= 0 && cursor <= finalContent.length,
      `Cursor ${cursor} should be valid for content length ${finalContent.length}`,
    );

    // Editor and Cell should be in sync
    const cellValue = await piece.result.get(["content"]) as string;
    assertEquals(
      finalContent,
      cellValue,
      "Editor and Cell should be in sync",
    );

    // Content should be user's typing (external update was a no-op)
    assertEquals(
      finalContent,
      "Hello WorldMore",
      "User's typing should apply when external update is a no-op",
    );
  });

  it("ADVERSARIAL: Very long content replacement should clamp cursor correctly", async () => {
    // Test: set very long content, position cursor at end, then replace with short content.
    // Cursor should be clamped, not left at an invalid position.
    const page = shell.page();

    await resetEditorState(page, piece);

    // Set very long content
    const longContent = "A".repeat(1000);
    await piece.result.set(longContent, ["content"]);

    await waitFor(
      async () => (await getEditorContent(page)) === longContent,
    );

    // Position cursor at the very end
    await focusEditor(page);
    await setCursorPosition(page, 1000);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, 1000, "Cursor should be at end of long content");

    // Replace with very short content
    await piece.result.set("X", ["content"]);

    await waitFor(
      async () => (await getEditorContent(page)) === "X",
    );

    // Cursor should be clamped to valid range [0, 1]
    const clampedCursor = await getCursorPosition(page);
    assert(
      clampedCursor >= 0 && clampedCursor <= 1,
      `Cursor should be clamped to [0, 1], got ${clampedCursor}`,
    );
  });

  it("ADVERSARIAL: Cell echo with slightly modified content should apply", async () => {
    // Edge case: Cell echoes back content that's ALMOST the same as what
    // was typed but with a small modification (e.g., trailing whitespace trimmed).
    // The hash comparison should detect this and apply the update.
    const page = shell.page();

    await resetEditorState(page, piece);

    await focusEditor(page);

    // Type content with trailing spaces
    await page.keyboard.type("Hello   ");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 8); // "Hello   " is 8 chars

    // Wait for debounce to send to Cell
    await waitFor(
      async () => await piece.result.get(["content"]) === "Hello   ",
    );

    // Simulate backend trimming the content
    await piece.result.set("Hello", ["content"]);

    // Wait for the update to apply
    await waitFor(
      async () => (await getEditorContent(page)) === "Hello",
    );

    // Cursor should be clamped to new length
    const finalCursor = await getCursorPosition(page);
    assert(
      finalCursor >= 0 && finalCursor <= 5,
      `Cursor should be clamped to [0, 5], got ${finalCursor}`,
    );
  });

  it("ADVERSARIAL: Typing during blur should not lose content", async () => {
    // Edge case: user types, then blurs before debounce completes.
    // The blur handler should flush any pending content.
    const page = shell.page();

    await resetEditorState(page, piece);

    await focusEditor(page);

    // Type some content
    await page.keyboard.type("Pre-blur content");

    // Immediately blur (before debounce)
    await page.evaluate(`
      (() => {
        const active = document.activeElement;
        if (active && active.blur) active.blur();
      })()
    `);

    // Wait for blur handler to flush content
    await new Promise((r) => setTimeout(r, 200));

    // Content should be saved to Cell
    const cellValue = await piece.result.get(["content"]) as string;
    assertEquals(
      cellValue,
      "Pre-blur content",
      "Content should be flushed on blur",
    );
  });

  it("ADVERSARIAL: Special characters should not break hash comparison", async () => {
    // Test with unicode, emoji, newlines - characters that might affect hashing
    const page = shell.page();

    await resetEditorState(page, piece);

    await focusEditor(page);

    // Type content with special characters
    const specialContent = "Hello 世界 🎉\nNew line\ttab";
    await page.keyboard.type(specialContent);

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, specialContent.length);

    // Wait for debounce
    await waitFor(
      async () => await piece.result.get(["content"]) === specialContent,
    );

    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    // Cursor should not jump
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      specialContent.length,
      "Cursor should not jump with special characters",
    );
  });

  it("ADVERSARIAL: Repeated identical Cell updates should be no-ops", async () => {
    // Sending the same content repeatedly to Cell should not cause cursor jumps
    const page = shell.page();

    await resetEditorState(page, piece);

    // Set initial content
    await piece.result.set("Static content", ["content"]);
    await waitFor(
      async () => (await getEditorContent(page)) === "Static content",
    );

    // Focus and position cursor in the middle
    await focusEditor(page);
    await setCursorPosition(page, 7);

    const initialCursor = await getCursorPosition(page);
    assertEquals(initialCursor, 7);

    // Send same content 10 times rapidly
    for (let i = 0; i < 10; i++) {
      await piece.result.set("Static content", ["content"]);
      await new Promise((r) => setTimeout(r, 20));
    }

    // Wait for any potential updates
    await new Promise((r) => setTimeout(r, 200));

    // Cursor should not have moved (identical content = no-op)
    const finalCursor = await getCursorPosition(page);
    assertEquals(
      finalCursor,
      7,
      "Cursor should not move when identical content is set",
    );
  });

  it("ADVERSARIAL: Typing exactly at debounce expiry should commit correctly", async () => {
    // Type, wait EXACTLY until debounce expires, then type again.
    // Both inputs should be committed.
    const page = shell.page();

    await resetEditorState(page, piece);

    await focusEditor(page);

    // First typing burst
    await page.keyboard.type("First");

    // Wait for debounce to complete
    await waitFor(
      async () => await piece.result.get(["content"]) === "First",
    );

    // Verify Cell has first content
    assertEquals(await piece.result.get(["content"]) as string, "First");

    // Immediately type more
    await page.keyboard.type("Second");

    const cursorAfterSecond = await getCursorPosition(page);
    assertEquals(cursorAfterSecond, 11); // "FirstSecond"

    // Wait for second debounce
    await waitFor(
      async () => await piece.result.get(["content"]) === "FirstSecond",
    );

    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    // Cursor should still be correct
    const finalCursor = await getCursorPosition(page);
    assertEquals(finalCursor, 11);
  });

  it("ADVERSARIAL: Rapid focus/blur cycles during typing should not corrupt content", async () => {
    // Focus, type, blur, focus, type - rapidly cycling while typing
    // Should maintain content integrity
    const page = shell.page();

    await resetEditorState(page, piece);

    // Focus and type first part
    await focusEditor(page);
    await page.keyboard.type("AAA");

    // Blur (triggers immediate debounce)
    await page.evaluate(`document.body.click()`);
    await new Promise((r) => setTimeout(r, 100));

    // Focus and type second part
    await focusEditor(page);
    await page.keyboard.type("BBB");

    // Blur again
    await page.evaluate(`document.body.click()`);
    await new Promise((r) => setTimeout(r, 100));

    // Focus and type third part
    await focusEditor(page);
    await page.keyboard.type("CCC");

    // Let final debounce complete
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + DEBOUNCE_BUFFER));

    // All typed content should be preserved
    const content = await getEditorContent(page);
    assertEquals(
      content,
      "AAABBBCCC",
      "All typed content should be preserved after focus/blur cycles",
    );

    // Cell should have same content
    const cellValue = await piece.result.get(["content"]);
    assertEquals(cellValue, "AAABBBCCC", "Cell should have all typed content");
  });

  it("ADVERSARIAL: External update between blur and debounce should apply correctly", async () => {
    // Type, blur (triggers immediate commit), then send external update
    // External update should apply since user is no longer typing
    const page = shell.page();

    await resetEditorState(page, piece);

    // Focus and type
    await focusEditor(page);
    await page.keyboard.type("UserContent");

    // Blur by explicitly calling blur() on the CodeMirror contentDOM
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
          ctEditor._editorView.contentDOM.blur();
        }
      })()
    `);

    // Wait for blur's debounce to complete - use longer timeout since blur->commit path may vary
    await waitFor(
      async () => await piece.result.get(["content"]) === "UserContent",
    );

    // Now send external update - should apply immediately
    await piece.result.set("ExternalAfterBlur", ["content"]);

    // Wait for sync
    await waitFor(
      async () => (await getEditorContent(page)) === "ExternalAfterBlur",
    );

    const content = await getEditorContent(page);
    assertEquals(
      content,
      "ExternalAfterBlur",
      "External update after blur should apply",
    );
  });

  /*
  // TODO(runtime-worker-refactor)
  it("ADVERSARIAL: Component disconnect/reconnect during typing should handle state correctly", async () => {
    // Type, disconnect component, reconnect, verify external updates work
    const page = shell.page();

    await resetEditorState(page, piece);

    // Focus and type
    await focusEditor(page);
    await page.keyboard.type("BeforeDisconnect");

    // Force disconnect/reconnect by navigating away and back
    // We'll simulate by canceling pending debounced writes
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
        if (ctEditor) {
          ctEditor._cellController.cancel();
        }
      })()
    `);

    // Now external updates should apply (simulating reconnection)
    await piece.result.set("AfterReconnect", ["content"]);

    // Wait for sync
    await waitFor(
      async () => (await getEditorContent(page)) === "AfterReconnect",
    );

    const content = await getEditorContent(page);
    assertEquals(
      content,
      "AfterReconnect",
      "External update should apply after canceling debounced writes",
    );
  });
  */

  it("ADVERSARIAL: Value property change to different Cell during typing", async () => {
    // This test verifies that switching to a different Cell mid-typing
    // properly cancels pending updates and resets state.
    // Note: We can't easily create a second Cell in this test harness,
    // but we can verify the value property change path works.
    const page = shell.page();

    await resetEditorState(page, piece);

    // Focus and type
    await focusEditor(page);
    await page.keyboard.type("TypingContent");

    // Simulate value property change by calling the path that updated() takes
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
        if (ctEditor) {
          // Simulate the reset that happens on value property change
          ctEditor._cellController.cancel();
        }
      })()
    `);

    // Wait longer than debounce to ensure no pending write happens
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + 200));

    const cellValue = await piece.result.get(["content"]);
    assertEquals(
      cellValue,
      "",
      "Pending debounced write should be canceled on value change",
    );

    // External update should still apply after cancellation
    await piece.result.set("AfterValueChange", ["content"]);
    await waitFor(
      async () => (await getEditorContent(page)) === "AfterValueChange",
      { timeout: 1000 },
    );
  });
});

/**
 * Reset editor state to empty for test isolation.
 * This is critical for adversarial tests that need clean state.
 */
async function resetEditorState(
  page: Page,
  pieceController: PieceController,
): Promise<void> {
  // Clear editor using annotation to avoid triggering typing timestamp
  await clearEditor(page);

  // Also clear Cell
  await pieceController.result.set("", ["content"]);

  // Wait for both to be empty and synchronized
  await waitFor(
    async () => {
      const editorContent = await getEditorContent(page);
      const cellValue = await pieceController.result.get(["content"]);
      return editorContent === "" && cellValue === "";
    },
  );

  // Extra settling time for any pending subscription callbacks
  await new Promise((r) => setTimeout(r, 300));
}

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
 * Clear the editor content.
 * Sets the guard flag to prevent updateListener from triggering Cell updates.
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
        // Clear editor content using the Cell sync annotation to prevent
        // updateListener from scheduling Cell writes.
        const annotation = ctEditor.constructor._cellSyncAnnotation;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" },
          selection: { anchor: 0, head: 0 },
          annotations: annotation ? annotation.of(true) : undefined
        });
      }
    })()
  `);
}
