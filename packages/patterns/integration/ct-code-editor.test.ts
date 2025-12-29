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

    // Clear any initial state first and wait for editor to show empty
    await clearEditor(page);
    // Also set Cell to empty to ensure sync
    await charm.result.set("", ["content"]);

    // Wait for both editor and Cell to be empty and synchronized
    await waitFor(
      async () => {
        const editorContent = await getEditorContent(page);
        const cellValue = charm.result.get(["content"]);
        return editorContent === "" && cellValue === "";
      },
      { timeout: 2000, delay: 50 },
    );

    // Extra settling time for any pending Cell subscription callbacks to drain.
    // This is critical because shared charm between tests can have stale
    // subscription callbacks queued that fire after we start typing.
    await new Promise((r) => setTimeout(r, 300));

    // Focus the editor
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
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === textToType,
      { timeout: DEBOUNCE_DELAY + 2000, delay: 50 },
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
    await charm.result.set("", ["content"]);
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
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === fullText,
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
      // deno-lint-ignore require-await
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
      // deno-lint-ignore require-await
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

  it("should defer external Cell update during debounce window to preserve cursor", async () => {
    const page = shell.page();

    // Clear the editor and sync Cell to empty
    await clearEditor(page);
    await charm.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Start typing
    await page.keyboard.type("User");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 4);

    // BEFORE debounce completes, simulate external update
    // This simulates another user/process updating the Cell
    await new Promise((r) => setTimeout(r, 200)); // Partway through debounce
    await charm.result.set("External Update", ["content"]);

    // Wait a moment for the external update to potentially propagate
    await new Promise((r) => setTimeout(r, 100));

    // The editor should STILL have the user's typed content (external update deferred)
    // This is the key behavior change: cursor stability takes priority over immediate sync
    const contentDuringDebounce = await getEditorContent(page);
    assertEquals(
      contentDuringDebounce,
      "User",
      "Editor should keep user's content during debounce (external update deferred)",
    );

    // Cursor should still be at end of typed content
    const cursorDuringDebounce = await getCursorPosition(page);
    assertEquals(
      cursorDuringDebounce,
      4,
      "Cursor should stay at end of typed content",
    );

    // Wait for debounce to complete - now the user's content will be committed
    // and the external update will be visible on next Cell sync
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + DEBOUNCE_BUFFER));

    // After debounce, the Cell will have the user's content (last write wins)
    const cellValue = charm.result.get(["content"]);
    assertEquals(
      cellValue,
      "User",
      "User's debounced update should win (last write wins)",
    );
  });

  it("should apply external update when no typing is in progress", async () => {
    // This test verifies that external updates are applied when the user
    // is NOT actively typing (no debounce window active). Also tests
    // cursor clamping when content is shortened.
    const page = shell.page();

    // Clear editor state from previous tests and sync Cell to empty
    await clearEditor(page);
    await charm.result.set("", ["content"]);
    // Allow time for any pending Cell subscription callbacks
    await new Promise((r) => setTimeout(r, 300));

    // Set long content externally (no typing, no hash stored)
    const longContent =
      "This is a very long piece of content that will be shortened";
    await charm.result.set(longContent, ["content"]);

    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === longContent;
      },
      { timeout: 2000 },
    );

    // Move cursor to end (still no typing)
    await focusEditor(page);
    await setCursorPosition(page, longContent.length);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, longContent.length);

    // External update shortens content drastically
    // Since no typing is in progress, this should apply immediately
    const shortContent = "Short";
    await charm.result.set(shortContent, ["content"]);

    await waitFor(
      async () => {
        const content = await getEditorContent(page);
        return content === shortContent;
      },
      { timeout: 2000 },
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
    await charm.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type text
    const text = "Test echo detection";
    await typeInEditor(page, text);

    const cursorBeforeEcho = await getCursorPosition(page);
    assertEquals(cursorBeforeEcho, text.length);

    // Wait for debounce to fire and Cell to update
    await waitFor(
      // deno-lint-ignore require-await
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

    // Clear the editor and sync Cell to empty
    await clearEditor(page);
    await charm.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type some text
    await typeInEditor(page, "Hello World");
    await waitFor(
      // deno-lint-ignore require-await
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
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === expectedText,
      { timeout: DEBOUNCE_DELAY + 1000 },
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
    await charm.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type and wait for sync
    await typeInEditor(page, "Hello World");
    await waitFor(
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === "Hello World",
      { timeout: DEBOUNCE_DELAY + 1000 },
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
    await charm.result.set("Short", ["content"]);

    // Wait for external update to apply
    await waitFor(
      async () => (await getEditorContent(page)) === "Short",
      { timeout: 2000 },
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
    await charm.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type and wait for debounce to complete
    await typeInEditor(page, "User typed");
    await waitFor(
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === "User typed",
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    // Wait extra time to ensure hash is fully cleared
    await new Promise((r) => setTimeout(r, 200));

    // Now external update should apply (no hash blocking it)
    await charm.result.set("External update", ["content"]);

    await waitFor(
      async () => (await getEditorContent(page)) === "External update",
      { timeout: 2000 },
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
    await charm.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    // Send 5 external updates rapidly (no user typing)
    for (let i = 0; i < 5; i++) {
      await charm.result.set(`Update ${i}`, ["content"]);
      await new Promise((r) => setTimeout(r, 50));
    }

    // Final content should be last update
    await waitFor(
      async () => (await getEditorContent(page)) === "Update 4",
      { timeout: 2000 },
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
    await charm.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    await focusEditor(page);

    // Type initial text
    await typeInEditor(page, "Hello");
    await waitFor(
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === "Hello",
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    // Type more text
    await typeInEditor(page, " World");
    await waitFor(
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === "Hello World",
      { timeout: DEBOUNCE_DELAY + 1000 },
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
    const cellValue = charm.result.get(["content"]);
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
    await charm.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 200));

    // Set initial content externally
    await charm.result.set("Hello World Test", ["content"]);
    await waitFor(
      async () => (await getEditorContent(page)) === "Hello World Test",
      { timeout: 2000 },
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
    await charm.result.set("Hi", ["content"]);
    await waitFor(
      async () => (await getEditorContent(page)) === "Hi",
      { timeout: 2000 },
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

    await resetEditorState(page, charm);

    await focusEditor(page);

    // Type some text
    await page.keyboard.type("Test");

    // Wait for ALMOST the full debounce window (490ms of 500ms)
    await new Promise((r) => setTimeout(r, 490));

    // Send external update at the boundary
    await charm.result.set("External at boundary", ["content"]);

    // Let the race play out
    await new Promise((r) => setTimeout(r, 200));

    // After settling, editor and Cell should match
    await waitFor(
      async () => {
        const e = await getEditorContent(page);
        const c = charm.result.get(["content"]);
        return e === c;
      },
      { timeout: 2000 },
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
    // CORRECT BEHAVIOR: User typing WINS over external Cell updates. External
    // updates that arrive during typing (within 500ms debounce window) are
    // DISCARDED to preserve user content. This is the "user typing wins" model.
    const page = shell.page();

    await resetEditorState(page, charm);

    await focusEditor(page);

    // Alternating pattern: type → Cell → type → Cell → type
    for (let i = 0; i < 3; i++) {
      // Type a character
      await page.keyboard.type(`${i}`);

      // Small delay to ensure typing is registered
      await new Promise((r) => setTimeout(r, 50));

      // Send Cell update (different content to force conflict)
      // This will be DISCARDED because user is typing
      await charm.result.set(`External-${i}`, ["content"]);

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

    // CORRECT EXPECTATION: User's typed content wins over external updates.
    // External updates during typing are discarded to preserve user content.
    const cellValue = charm.result.get(["content"]) as string;
    assertEquals(
      content,
      cellValue,
      "Editor and Cell should be in sync after settling",
    );

    // The final value should be the user's typed content
    assertEquals(
      content,
      "012",
      "User's typed content should win over external updates",
    );
  });

  it("ADVERSARIAL: Multiple Cell updates while user is continuously typing", async () => {
    // User types continuously (letters every 50ms) while external updates
    // bombard the Cell. The editor should not corrupt or crash.
    //
    // CORRECT BEHAVIOR: User typing WINS over external Cell updates. External
    // updates that arrive during typing are DISCARDED to preserve user content.
    // This is the "user typing wins" model - the user's input takes priority.
    const page = shell.page();

    await resetEditorState(page, charm);

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
        await charm.result.set(`Bombard-${i}`, ["content"]);
      }
    })();

    // Wait for both to complete
    await Promise.all([typingPromise, cellBombardPromise]);

    // Let debounce complete
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + 300));

    // Final state should be consistent
    const content = await getEditorContent(page);
    const cursor = await getCursorPosition(page);
    const cellValue = charm.result.get(["content"]) as string;

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

    // CORRECT EXPECTATION: User's typed content wins over external updates.
    // External updates during typing are discarded to preserve user content.
    assertEquals(
      content,
      "ABCDEFGHIJ",
      "User's typed content should win over external updates",
    );
  });

  it("ADVERSARIAL: Empty string Cell update during typing", async () => {
    // Edge case: Cell is set to empty while user is typing.
    // This can cause cursor position > content length if not handled.
    //
    // ACTUAL BEHAVIOR: The empty string Cell update during typing is deferred.
    // When the user continues typing, the user's content overwrites the Cell's
    // empty string before the deferred update can be applied. This is a race
    // condition where user typing wins. The key invariants to test:
    // 1. Cursor remains valid (no crashes from cursor > content.length)
    // 2. Editor and Cell are eventually consistent
    // 3. Content matches one of the valid states (empty or user's content)
    const page = shell.page();

    await resetEditorState(page, charm);

    await focusEditor(page);

    // Type some content
    await page.keyboard.type("Hello World");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 11);

    // Immediately try to clear via Cell (within debounce window)
    // Cell value becomes "", but editor still shows "Hello World" (deferred)
    await charm.result.set("", ["content"]);

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
    const cellValue = charm.result.get(["content"]) as string;
    assertEquals(
      finalContent,
      cellValue,
      "Editor and Cell should be in sync",
    );

    // Content should be user's typing (user won the race)
    // The external "" arrived and set the Cell to "", but the user's
    // subsequent typing overwrote it before the deferred update could apply.
    assertEquals(
      finalContent,
      "Hello WorldMore",
      "User's typing should win when they continue typing after external update",
    );
  });

  it("ADVERSARIAL: Very long content replacement should clamp cursor correctly", async () => {
    // Test: set very long content, position cursor at end, then replace with short content.
    // Cursor should be clamped, not left at an invalid position.
    const page = shell.page();

    await resetEditorState(page, charm);

    // Set very long content
    const longContent = "A".repeat(1000);
    await charm.result.set(longContent, ["content"]);

    await waitFor(
      async () => (await getEditorContent(page)) === longContent,
      { timeout: 2000 },
    );

    // Position cursor at the very end
    await focusEditor(page);
    await setCursorPosition(page, 1000);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, 1000, "Cursor should be at end of long content");

    // Replace with very short content
    await charm.result.set("X", ["content"]);

    await waitFor(
      async () => (await getEditorContent(page)) === "X",
      { timeout: 2000 },
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

    await resetEditorState(page, charm);

    await focusEditor(page);

    // Type content with trailing spaces
    await page.keyboard.type("Hello   ");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 8); // "Hello   " is 8 chars

    // Wait for debounce to send to Cell
    await waitFor(
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === "Hello   ",
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    // Simulate backend trimming the content
    await charm.result.set("Hello", ["content"]);

    // Wait for the update to apply
    await waitFor(
      async () => (await getEditorContent(page)) === "Hello",
      { timeout: 2000 },
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

    await resetEditorState(page, charm);

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
    const cellValue = charm.result.get(["content"]) as string;
    assertEquals(
      cellValue,
      "Pre-blur content",
      "Content should be flushed on blur",
    );
  });

  it("ADVERSARIAL: Special characters should not break hash comparison", async () => {
    // Test with unicode, emoji, newlines - characters that might affect hashing
    const page = shell.page();

    await resetEditorState(page, charm);

    await focusEditor(page);

    // Type content with special characters
    const specialContent = "Hello 世界 🎉\nNew line\ttab";
    await page.keyboard.type(specialContent);

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, specialContent.length);

    // Wait for debounce
    await waitFor(
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === specialContent,
      { timeout: DEBOUNCE_DELAY + 1000 },
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

    await resetEditorState(page, charm);

    // Set initial content
    await charm.result.set("Static content", ["content"]);
    await waitFor(
      async () => (await getEditorContent(page)) === "Static content",
      { timeout: 2000 },
    );

    // Focus and position cursor in the middle
    await focusEditor(page);
    await setCursorPosition(page, 7);

    const initialCursor = await getCursorPosition(page);
    assertEquals(initialCursor, 7);

    // Send same content 10 times rapidly
    for (let i = 0; i < 10; i++) {
      await charm.result.set("Static content", ["content"]);
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

    await resetEditorState(page, charm);

    await focusEditor(page);

    // First typing burst
    await page.keyboard.type("First");

    // Wait for debounce to complete
    await waitFor(
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === "First",
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    // Verify Cell has first content
    assertEquals(charm.result.get(["content"]) as string, "First");

    // Immediately type more
    await page.keyboard.type("Second");

    const cursorAfterSecond = await getCursorPosition(page);
    assertEquals(cursorAfterSecond, 11); // "FirstSecond"

    // Wait for second debounce
    await waitFor(
      // deno-lint-ignore require-await
      async () => charm.result.get(["content"]) === "FirstSecond",
      { timeout: DEBOUNCE_DELAY + 1000 },
    );

    await new Promise((r) => setTimeout(r, DEBOUNCE_BUFFER));

    // Cursor should still be correct
    const finalCursor = await getCursorPosition(page);
    assertEquals(finalCursor, 11);
  });
});

/**
 * Reset editor state to empty for test isolation.
 * This is critical for adversarial tests that need clean state.
 */
async function resetEditorState(
  page: Page,
  charmController: CharmController,
): Promise<void> {
  // Clear editor using annotation to avoid triggering typing timestamp
  await clearEditor(page);

  // Also clear Cell
  await charmController.result.set("", ["content"]);

  // Wait for both to be empty and synchronized
  await waitFor(
    async () => {
      const editorContent = await getEditorContent(page);
      const cellValue = charmController.result.get(["content"]);
      return editorContent === "" && cellValue === "";
    },
    { timeout: 2000, delay: 50 },
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
 * Sets the guard flag to prevent updateListener from triggering Cell updates,
 * and clears the _isTyping flag to allow subsequent external updates to apply.
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
        // triggering the _isTyping flag. This allows subsequent external
        // Cell updates to apply immediately.
        const annotation = ctEditor.constructor._cellSyncAnnotation;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" },
          selection: { anchor: 0, head: 0 },
          annotations: annotation ? annotation.of(true) : undefined
        });
        // Also reset the typing flag directly for safety
        ctEditor._isTyping = false;
      }
    })()
  `);
}
