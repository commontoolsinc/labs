/**
 * Integration tests for cf-code-editor cursor stability.
 *
 * Tests that the cursor doesn't jump when:
 * 1. Typing normally (Cell echoes back after debounce)
 * 2. Rapid typing with debounce window
 * 3. External Cell updates during typing
 *
 * The critical flow being tested:
 * - User types → editor updates → debounced Cell update (500ms)
 * - Cell echo fires → content compared → if match, skip update → cursor stays
 *
 * Waits are event-driven: editor-state conditions use waitForCondition (an
 * in-page waiter re-evaluated on DOM mutation), and committed cell values are
 * awaited through the result-cell sink. The remaining setTimeout calls
 * construct timing scenarios (an update landing inside the component's
 * wall-clock debounce window, or a settling period after which a canceled
 * write must NOT have fired); they are the scenario, not a wait for a result.
 */
import {
  awaitViewSettled,
  env,
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { ANYONE_USER } from "@commonfabric/memory/acl";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { waitForRuntimeSynced } from "./cfc-browser-helpers.ts";
import { defer, type Deferred } from "@commonfabric/utils/defer";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

// Debounce delay configured in cf-code-editor (default timingDelay)
const DEBOUNCE_DELAY = 500;
const DEBOUNCE_BUFFER = 100; // Extra time for processing

// In-page predicate for waitForCondition: the editor document text equals
// `expected`. `probe.collect` pierces shadow roots to find the editor host.
const editorContentIs = (probe: ProbeApi, expected: string): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as
    | (Element & { _editorView?: { state: { doc: { toString(): string } } } })
    | undefined;
  return editor?._editorView?.state.doc.toString() === expected;
};

// In-page predicate: the editor host exists and its CodeMirror view is up.
const editorReady = (probe: ProbeApi): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as
    | (Element & { _editorView?: unknown })
    | undefined;
  return editor?._editorView !== undefined;
};

/** Wait until the editor's document text equals `expected`. */
async function waitForEditorContent(
  page: Page,
  expected: string,
): Promise<void> {
  try {
    await waitForCondition(page, editorContentIs, { args: [expected] });
  } catch (cause) {
    const actual = await getEditorContent(page).catch(() => "<unreadable>");
    throw new Error(
      `Editor content did not become ${JSON.stringify(expected)}; ` +
        `last content: ${JSON.stringify(actual)}`,
      { cause },
    );
  }
}

describe("cf-code-editor cursor stability", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let pieceSinkCancel: (() => void) | undefined;
  // The piece's committed content value, tracked by the result-cell sink
  // below, and a one-shot waiter the sink resolves when the value reaches a
  // target.
  let latestContent: string | undefined;
  let contentWaiter: { target: string; deferred: Deferred } | undefined;

  // Resolve once the piece's committed content equals `target`. The sink
  // fires with the current value on registration and on every committed
  // change, so a value already at the target resolves immediately; otherwise
  // the sink resolves the waiter when the target lands.
  const awaitCellContent = (target: string): Promise<void> => {
    if (latestContent === target) return Promise.resolve();
    const deferred = defer();
    contentWaiter = { target, deferred };
    return deferred.promise;
  };

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    piece = await cc.create(
      await Deno.readTextFile(
        join(import.meta.dirname!, "..", "examples", "cf-code-editor-cell.tsx"),
      ),
      { start: true },
    );

    // Add permissions for ANYONE
    await cc.acl().set(ANYONE_USER, "WRITE");

    // In pull mode, create a sink to keep the piece reactive when inputs
    // change. The sink also drives awaitCellContent: it records the latest
    // committed content and resolves a pending waiter when its target lands.
    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink((value) => {
      latestContent = (value as { content?: string } | undefined)?.content;
      if (contentWaiter && latestContent === contentWaiter.target) {
        contentWaiter.deferred.resolve();
        contentWaiter = undefined;
      }
    });
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    if (cc) await cc.dispose();
  });

  /**
   * Reset editor state to empty for test isolation: clear the editor without
   * scheduling a cell write, clear the cell, and wait until the editor, the
   * committed cell value, and the page's runtime have all settled at empty.
   */
  async function resetEditorState(page: Page): Promise<void> {
    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await waitForEditorContent(page, "");
    await awaitCellContent("");
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);
  }

  /**
   * Wait for the cell echo of a just-committed edit to reach the page: the
   * committed value is already at `content`, so once the page's runtime has
   * synced and the view has settled, the subscription delivery (and its
   * potential — incorrect — cursor move) has happened.
   */
  async function awaitEchoDelivered(page: Page): Promise<void> {
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);
  }

  it("should load the cf-code-editor piece", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });
    await waitForCondition(page, editorReady);
  });

  it("should sync Cell value to editor", async () => {
    const page = shell.page();
    const text = "initial";

    // Clear any initial state first and wait for editor to show empty
    await resetEditorState(page);

    // Set Cell value
    await piece.result.set(text, ["content"]);

    // Wait for editor to reflect it
    await waitForEditorContent(page, text);

    // Clear for next test
    await piece.result.set("", ["content"]);
    await waitForEditorContent(page, "");
  });

  it("should maintain cursor position during normal typing with Cell echo", async () => {
    const page = shell.page();

    await resetEditorState(page);

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
    await awaitCellContent(textToType);

    // Wait for the Cell echo to propagate back to the page.
    await awaitEchoDelivered(page);

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

    await resetEditorState(page);
    await focusEditor(page);

    // Type several characters rapidly (within debounce window). The short
    // pause between characters constructs the scenario: each keystroke lands
    // inside the debounce window of the previous one and resets its timer.
    const chars = ["A", "B", "C", "D", "E"];
    for (const char of chars) {
      await page.keyboard.type(char);
      await new Promise((r) => setTimeout(r, 50));
    }

    const fullText = chars.join("");

    // Verify cursor is at end immediately
    const cursorBeforeDebounce = await getCursorPosition(page);
    assertEquals(cursorBeforeDebounce, fullText.length);

    // Wait for debounce to complete (only fires ONCE after last character)
    await awaitCellContent(fullText);
    await awaitEchoDelivered(page);

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

    await resetEditorState(page);
    const initialText = "Start End";
    await typeInEditor(page, initialText);

    // Wait for Cell to sync
    await awaitCellContent(initialText);

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
    await awaitCellContent(expectedText);
    await awaitEchoDelivered(page);

    // Cursor should stay where it was after typing
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      13,
      "Cursor should not jump to end or 0 after Cell echo",
    );
  });

  it("should preserve a pending local edit over an external update during the debounce window", async () => {
    // A locally-edited value that bound state has not yet confirmed wins over
    // deliveries of other values until its write settles (see CellController's
    // pending-local-edit tracking); an external update landing mid-debounce
    // must not repaint the editor, and the local edit commits over it.
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Start typing
    await page.keyboard.type("User");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 4);

    // BEFORE debounce completes, simulate external update. The pause places
    // the update partway through the component's 500ms debounce window.
    await new Promise((r) => setTimeout(r, 200));
    await piece.result.set("External Update", ["content"]);

    // The pending local edit's debounced write commits over the external
    // value.
    await awaitCellContent("User");
    await awaitEchoDelivered(page);

    // The editor kept the local edit throughout; the cursor never moved.
    const editorContent = await getEditorContent(page);
    assertEquals(
      editorContent,
      "User",
      "Editor should keep the pending local edit over the external update",
    );
    const cursorAfterCommit = await getCursorPosition(page);
    assertEquals(
      cursorAfterCommit,
      4,
      "Cursor should remain in place while the local edit is pending",
    );
  });

  it("should apply external update when no typing is in progress", async () => {
    // This test verifies that external updates are applied when the user
    // is NOT actively typing (no debounce window active). Also tests
    // cursor clamping when content is shortened.
    const page = shell.page();

    await resetEditorState(page);

    // Set long content externally (no typing)
    const longContent =
      "This is a very long piece of content that will be shortened";
    await piece.result.set(longContent, ["content"]);
    await waitForEditorContent(page, longContent);

    // Move cursor to end (still no typing)
    await focusEditor(page);
    await setCursorPosition(page, longContent.length);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, longContent.length);

    // External update shortens content drastically
    // Since no typing is in progress, this should apply immediately
    const shortContent = "Short";
    await piece.result.set(shortContent, ["content"]);
    await waitForEditorContent(page, shortContent);

    // Cursor should be clamped to new content length
    const cursorAfterShorten = await getCursorPosition(page);
    assert(
      cursorAfterShorten >= 0 && cursorAfterShorten <= shortContent.length,
      `Cursor should be clamped to [0, ${shortContent.length}], got ${cursorAfterShorten}`,
    );
  });

  it("should not apply Cell echo if content matches (own change)", async () => {
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Type text
    const text = "Test echo detection";
    await typeInEditor(page, text);

    const cursorBeforeEcho = await getCursorPosition(page);
    assertEquals(cursorBeforeEcho, text.length);

    // Wait for debounce to fire and Cell to update
    await awaitCellContent(text);

    // The Cell echo should be detected and skipped (content match)
    // Cursor should NOT move
    await awaitEchoDelivered(page);

    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      text.length,
      "Cursor should not move when Cell echo is detected (content match)",
    );

    // Now simulate EXTERNAL change with different content
    await piece.result.set("Different content", ["content"]);
    await waitForEditorContent(page, "Different content");
  });

  it("should handle backspace and maintain cursor", async () => {
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Type some text
    await typeInEditor(page, "Hello World");
    await awaitCellContent("Hello World");

    // Backspace several times to delete " World". The short pause between
    // keystrokes keeps each one inside the previous one's debounce window.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Backspace");
      await new Promise((r) => setTimeout(r, 50));
    }

    const expectedText = "Hello";
    const cursorAfterBackspace = await getCursorPosition(page);
    assertEquals(cursorAfterBackspace, expectedText.length);

    // Wait for debounce
    await awaitCellContent(expectedText);
    await awaitEchoDelivered(page);

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

    await resetEditorState(page);
    await focusEditor(page);

    // Type and wait for sync
    await typeInEditor(page, "Hello World");
    await awaitCellContent("Hello World");

    // Blur the editor - this should allow external updates to apply
    await page.evaluate(`
      (() => {
        const active = document.activeElement;
        if (active && active.blur) active.blur();
      })()
    `);

    // External update with shorter content
    await piece.result.set("Short", ["content"]);
    await waitForEditorContent(page, "Short");

    // Cursor should be clamped to new content length (not stuck at old position)
    const cursor = await getCursorPosition(page);
    assert(
      cursor >= 0 && cursor <= "Short".length,
      `Cursor should be clamped to [0, 5], got ${cursor}`,
    );
  });

  it("should apply external update after debounce window fully expires", async () => {
    // After debounce completes, external updates should apply
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Type and wait for debounce to complete
    await typeInEditor(page, "User typed");
    await awaitCellContent("User typed");
    await awaitEchoDelivered(page);

    // Now external update should apply (no pending local edit blocking it)
    await piece.result.set("External update", ["content"]);
    await waitForEditorContent(page, "External update");
  });

  // ==========================================================================
  // STRESS TESTS: Edge cases and rapid operations
  // ==========================================================================

  it("should handle multiple rapid external updates correctly", async () => {
    // Stress test: rapid Cell updates should all apply correctly
    const page = shell.page();

    await resetEditorState(page);

    // Send 5 external updates in quick succession (no user typing)
    for (let i = 0; i < 5; i++) {
      await piece.result.set(`Update ${i}`, ["content"]);
    }

    // Final content should be last update
    await waitForEditorContent(page, "Update 4");

    // Cursor should be valid
    const cursor = await getCursorPosition(page);
    assert(
      cursor >= 0 && cursor <= "Update 4".length,
      `Cursor should be valid, got ${cursor}`,
    );
  });

  it("should handle undo operation and maintain correct state", async () => {
    // Undo triggers updateListener - verify echo detection doesn't cause issues
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Type initial text
    await typeInEditor(page, "Hello");
    await awaitCellContent("Hello");

    // Type more text
    await typeInEditor(page, " World");
    await awaitCellContent("Hello World");

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
    await awaitViewSettled(page);

    // After undo, editor should show previous state
    const contentAfterUndo = await getEditorContent(page);
    // Note: Undo behavior depends on CodeMirror's history - content may vary
    // The key test is that cursor is valid and no crash occurs
    const cursorAfterUndo = await getCursorPosition(page);
    assert(
      cursorAfterUndo >= 0 && cursorAfterUndo <= contentAfterUndo.length,
      `Cursor should be valid after undo, got ${cursorAfterUndo}`,
    );

    // The undo edit schedules its own debounced write; wait for the committed
    // value to catch up with the editor.
    await awaitCellContent(contentAfterUndo);

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

    await resetEditorState(page);

    // Set initial content externally
    await piece.result.set("Hello World Test", ["content"]);
    await waitForEditorContent(page, "Hello World Test");

    await focusEditor(page);

    // Select "World" (positions 6-11)
    await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (cfEditor && cfEditor._editorView) {
          cfEditor._editorView.dispatch({
            selection: { anchor: 6, head: 11 }
          });
        }
      })()
    `);

    // Verify selection
    const selection = (await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (!cfEditor || !cfEditor._editorView) return null;
        const sel = cfEditor._editorView.state.selection.main;
        return { anchor: sel.anchor, head: sel.head };
      })()
    `)) as { anchor: number; head: number };
    assertEquals(selection.anchor, 6);
    assertEquals(selection.head, 11);

    // External update with shorter content - selection should be clamped
    await piece.result.set("Hi", ["content"]);
    await waitForEditorContent(page, "Hi");

    // Selection should be clamped to new content length
    const clampedSelection = (await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (!cfEditor || !cfEditor._editorView) return null;
        const sel = cfEditor._editorView.state.selection.main;
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
    // when the debounce timer fires. Either side may win the race; the
    // invariant is that editor and Cell converge and the cursor stays valid.
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Type some text
    await page.keyboard.type("Test");

    // Wait for ALMOST the full debounce window (490ms of 500ms), then send
    // the external update at the boundary. The two pauses construct the
    // race; the second lets whichever side lost the race finish.
    await new Promise((r) => setTimeout(r, 490));
    await piece.result.set("External at boundary", ["content"]);
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + DEBOUNCE_BUFFER));

    // After settling, editor and Cell should match
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);
    const editorContent = await getEditorContent(page);
    const cellContent = await piece.result.get(["content"]);
    assertEquals(
      editorContent,
      cellContent,
      "Editor and Cell should converge after the boundary race",
    );

    // Cursor should be valid
    const cursor = await getCursorPosition(page);
    assert(
      cursor >= 0 && cursor <= editorContent.length,
      `Cursor ${cursor} should be valid for content length ${editorContent.length}`,
    );
  });

  it("ADVERSARIAL: Rapid alternating type-Cell-type-Cell pattern", async () => {
    // Simulates a pathological case: user types, Cell updates, user types again
    // repeatedly. This can expose issues with edit tracking.
    //
    // CORRECT BEHAVIOR: the pending local edit wins over external deliveries
    // for as long as its write has not settled, so the typed characters
    // accumulate and the debounced write commits them over the external
    // values.
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Alternating pattern: type → Cell → type → Cell → type. The pauses
    // place each external update inside the debounce window opened by the
    // keystroke before it.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.type(`${i}`);
      await new Promise((r) => setTimeout(r, 50));
      await piece.result.set(`External-${i}`, ["content"]);
      await new Promise((r) => setTimeout(r, 100));
    }

    // The typed characters commit as one debounced write.
    await awaitCellContent("012");
    await awaitEchoDelivered(page);

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

    // The final value is the accumulated local edit
    assertEquals(
      content,
      "012",
      "Pending local edits should win over external updates while unsettled",
    );
  });

  it("ADVERSARIAL: Multiple Cell updates while user is continuously typing", async () => {
    // User types continuously (letters every 50ms) while external updates
    // bombard the Cell. The editor should not corrupt or crash.
    //
    // CORRECT BEHAVIOR: the pending local edit wins over the bombarding
    // deliveries for as long as its write has not settled, so the typed
    // characters accumulate and commit as one debounced write.
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Interleave keystrokes and external updates on their own clocks; the
    // pauses shape the interleaving.
    const typingPromise = (async () => {
      for (let i = 0; i < 10; i++) {
        await page.keyboard.type(String.fromCharCode(65 + i)); // A, B, C...
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    const cellBombardPromise = (async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 80));
        await piece.result.set(`Bombard-${i}`, ["content"]);
      }
    })();

    await Promise.all([typingPromise, cellBombardPromise]);

    // The typed characters commit as one debounced write over the bombards.
    await awaitCellContent("ABCDEFGHIJ");
    await awaitEchoDelivered(page);

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

    assertEquals(
      content,
      "ABCDEFGHIJ",
      "Typed content should win over the bombarding external updates",
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

    await resetEditorState(page);
    await focusEditor(page);

    // Type some content
    await page.keyboard.type("Hello World");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 11);

    // Immediately try to clear via Cell (within debounce window; the pause
    // keeps the follow-up typing inside the same window).
    await piece.result.set("", ["content"]);
    await new Promise((r) => setTimeout(r, 100));

    // User continues typing - editor now has "Hello WorldMore"
    // This triggers setValue which will overwrite the Cell's ""
    await page.keyboard.type("More");

    // The combined edit commits after debounce.
    await awaitCellContent("Hello WorldMore");
    await awaitEchoDelivered(page);

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

    await resetEditorState(page);

    // Set very long content
    const longContent = "A".repeat(1000);
    await piece.result.set(longContent, ["content"]);
    await waitForEditorContent(page, longContent);

    // Position cursor at the very end
    await focusEditor(page);
    await setCursorPosition(page, 1000);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, 1000, "Cursor should be at end of long content");

    // Replace with very short content
    await piece.result.set("X", ["content"]);
    await waitForEditorContent(page, "X");

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
    // The content comparison should detect this and apply the update.
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Type content with trailing spaces
    await page.keyboard.type("Hello   ");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 8); // "Hello   " is 8 chars

    // Wait for debounce to send to Cell
    await awaitCellContent("Hello   ");

    // Simulate backend trimming the content
    await piece.result.set("Hello", ["content"]);
    await waitForEditorContent(page, "Hello");

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

    await resetEditorState(page);
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

    // The blur handler flushes the pending content to the Cell.
    await awaitCellContent("Pre-blur content");
  });

  it("ADVERSARIAL: Special characters should not break echo detection", async () => {
    // Test with unicode, emoji, newlines - characters that might affect the
    // content comparison
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // Type content with special characters
    const specialContent = "Hello 世界 🎉\nNew line\ttab";
    await page.keyboard.type(specialContent);

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, specialContent.length);

    // Wait for debounce
    await awaitCellContent(specialContent);
    await awaitEchoDelivered(page);

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

    await resetEditorState(page);

    // Set initial content
    await piece.result.set("Static content", ["content"]);
    await waitForEditorContent(page, "Static content");

    // Focus and position cursor in the middle
    await focusEditor(page);
    await setCursorPosition(page, 7);

    const initialCursor = await getCursorPosition(page);
    assertEquals(initialCursor, 7);

    // Send same content 10 times in quick succession
    for (let i = 0; i < 10; i++) {
      await piece.result.set("Static content", ["content"]);
    }

    // A re-set to the same value commits no change, so there is no event to
    // await; settle the page and verify nothing moved.
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);

    // Cursor should not have moved (identical content = no-op)
    const finalCursor = await getCursorPosition(page);
    assertEquals(
      finalCursor,
      7,
      "Cursor should not move when identical content is set",
    );
  });

  it("ADVERSARIAL: Typing exactly at debounce expiry should commit correctly", async () => {
    // Type, wait until the first debounce commits, then type again.
    // Both inputs should be committed.
    const page = shell.page();

    await resetEditorState(page);
    await focusEditor(page);

    // First typing burst
    await page.keyboard.type("First");

    // Wait for debounce to complete
    await awaitCellContent("First");

    // Immediately type more
    await page.keyboard.type("Second");

    const cursorAfterSecond = await getCursorPosition(page);
    assertEquals(cursorAfterSecond, 11); // "FirstSecond"

    // Wait for second debounce
    await awaitCellContent("FirstSecond");
    await awaitEchoDelivered(page);

    // Cursor should still be correct
    const finalCursor = await getCursorPosition(page);
    assertEquals(finalCursor, 11);
  });

  it("ADVERSARIAL: Rapid focus/blur cycles during typing should not corrupt content", async () => {
    // Focus, type, blur, focus, type - rapidly cycling while typing
    // Should maintain content integrity. Each blur flushes the pending edit.
    const page = shell.page();

    await resetEditorState(page);

    // Focus and type first part, blur to flush
    await focusEditor(page);
    await page.keyboard.type("AAA");
    await page.evaluate(`document.body.click()`);
    await awaitCellContent("AAA");

    // Focus and type second part, blur to flush
    await focusEditor(page);
    await page.keyboard.type("BBB");
    await page.evaluate(`document.body.click()`);
    await awaitCellContent("AAABBB");

    // Focus and type third part, let the debounce commit it
    await focusEditor(page);
    await page.keyboard.type("CCC");
    await awaitCellContent("AAABBBCCC");

    // All typed content should be preserved
    const content = await getEditorContent(page);
    assertEquals(
      content,
      "AAABBBCCC",
      "All typed content should be preserved after focus/blur cycles",
    );
  });

  it("ADVERSARIAL: External update between blur and debounce should apply correctly", async () => {
    // Type, blur (triggers immediate commit), then send external update
    // External update should apply since user is no longer typing
    const page = shell.page();

    await resetEditorState(page);

    // Focus and type
    await focusEditor(page);
    await page.keyboard.type("UserContent");

    // Blur by explicitly calling blur() on the CodeMirror contentDOM
    await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (cfEditor && cfEditor._editorView) {
          cfEditor._editorView.contentDOM.blur();
        }
      })()
    `);

    // The blur flushes the typed content to the Cell.
    await awaitCellContent("UserContent");

    // Now send external update - should apply since no typing is in progress
    await piece.result.set("ExternalAfterBlur", ["content"]);
    await waitForEditorContent(page, "ExternalAfterBlur");
  });

  it("ADVERSARIAL: Value property change to different Cell during typing", async () => {
    // This test verifies that switching to a different Cell mid-typing
    // properly cancels pending updates and resets state.
    // Note: We can't easily create a second Cell in this test harness,
    // but we can verify the value property change path works.
    const page = shell.page();

    await resetEditorState(page);

    // Focus and type
    await focusEditor(page);
    await page.keyboard.type("TypingContent");

    // Simulate value property change by calling the path that updated() takes
    await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (cfEditor) {
          // Simulate the reset that happens on value property change
          cfEditor._cellController.cancel();
        }
      })()
    `);

    // Wait out the debounce window: the canceled write must NOT fire, and a
    // negative can only be observed by letting the window in which it would
    // have fired elapse.
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + DEBOUNCE_BUFFER));

    const cellValue = await piece.result.get(["content"]);
    assertEquals(
      cellValue,
      "",
      "Pending debounced write should be canceled on value change",
    );

    // External update should still apply after cancellation
    await piece.result.set("AfterValueChange", ["content"]);
    await waitForEditorContent(page, "AfterValueChange");
  });
});

/**
 * Get current cursor position in the cf-code-editor
 */
async function getCursorPosition(page: Page): Promise<number> {
  const result = await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor || !cfEditor._editorView) return -1;

      return cfEditor._editorView.state.selection.main.head;
    })()
  `);
  return result as number;
}

/**
 * Get current content from the cf-code-editor
 */
async function getEditorContent(page: Page): Promise<string> {
  const result = await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor || !cfEditor._editorView) return "";

      return cfEditor._editorView.state.doc.toString();
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
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (cfEditor && cfEditor._editorView) {
        cfEditor._editorView.focus();
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
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (cfEditor && cfEditor._editorView) {
        cfEditor._editorView.dispatch({
          selection: { anchor: pos, head: pos }
        });
      }
    })(${position})
  `);
}

/**
 * Clear the editor content.
 * Uses the Cell sync annotation to prevent updateListener from scheduling
 * Cell writes.
 */
async function clearEditor(page: Page): Promise<void> {
  await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (cfEditor && cfEditor._editorView) {
        const view = cfEditor._editorView;
        // Clear editor content using the Cell sync annotation to prevent
        // updateListener from scheduling Cell writes.
        const annotation = cfEditor.constructor._cellSyncAnnotation;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" },
          selection: { anchor: 0, head: 0 },
          annotations: annotation ? annotation.of(true) : undefined
        });
      }
    })()
  `);
}
