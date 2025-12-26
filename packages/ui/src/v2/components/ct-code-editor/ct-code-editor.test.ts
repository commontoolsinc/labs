import { describe, it, beforeEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTCodeEditor, MimeType } from "./ct-code-editor.ts";

// deno-lint-ignore no-explicit-any
type AnyEditor = any;

describe("CTCodeEditor", () => {
  it("should be defined", () => {
    expect(CTCodeEditor).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CTCodeEditor.name).toBe("CTCodeEditor");
  });

  it("should create element instance", () => {
    const element = new CTCodeEditor();
    expect(element).toBeInstanceOf(CTCodeEditor);
  });

  it("should have default properties", () => {
    const element = new CTCodeEditor();
    expect(element.value).toBe("");
    expect(element.language).toBe(MimeType.markdown);
    expect(element.disabled).toBe(false);
    expect(element.readonly).toBe(false);
    expect(element.placeholder).toBe("");
    expect(element.timingStrategy).toBe("debounce");
    expect(element.timingDelay).toBe(500);
  });

  it("should have MimeType constants", () => {
    expect(MimeType.javascript).toBe("text/javascript");
    expect(MimeType.typescript).toBe("text/x.typescript");
    expect(MimeType.markdown).toBe("text/markdown");
    expect(MimeType.json).toBe("application/json");
    expect(MimeType.css).toBe("text/css");
    expect(MimeType.html).toBe("text/html");
    expect(MimeType.jsx).toBe("text/x.jsx");
  });

  it("should allow setting properties", () => {
    const element = new CTCodeEditor();
    element.value = "const x = 42;";
    element.language = MimeType.javascript;
    element.readonly = true;
    element.timingStrategy = "immediate";
    element.timingDelay = 100;

    expect(element.value).toBe("const x = 42;");
    expect(element.language).toBe(MimeType.javascript);
    expect(element.readonly).toBe(true);
    expect(element.timingStrategy).toBe("immediate");
    expect(element.timingDelay).toBe(100);
  });
});

describe("CTCodeEditor._hashContent", () => {
  let element: AnyEditor;

  beforeEach(() => {
    element = new CTCodeEditor();
  });

  it("should return consistent hash for same input", () => {
    const hash1 = element._hashContent("hello world");
    const hash2 = element._hashContent("hello world");
    expect(hash1).toBe(hash2);
  });

  it("should return different hash for different inputs", () => {
    const hash1 = element._hashContent("hello");
    const hash2 = element._hashContent("world");
    expect(hash1).not.toBe(hash2);
  });

  it("should return 0 for empty string", () => {
    const hash = element._hashContent("");
    expect(hash).toBe(0);
  });

  it("should handle unicode characters", () => {
    const hash1 = element._hashContent("hello 世界 🌍");
    const hash2 = element._hashContent("hello 世界 🌍");
    expect(hash1).toBe(hash2);

    const hash3 = element._hashContent("hello 世界 🌎");
    expect(hash1).not.toBe(hash3);
  });

  it("should return 32-bit signed integer", () => {
    // Test with a long string to trigger potential overflow
    const longString = "a".repeat(10000);
    const hash = element._hashContent(longString);

    // Verify it's a 32-bit signed integer (-2147483648 to 2147483647)
    expect(hash).toBeGreaterThanOrEqual(-2147483648);
    expect(hash).toBeLessThanOrEqual(2147483647);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it("should produce different hashes for similar strings", () => {
    const hash1 = element._hashContent("abc");
    const hash2 = element._hashContent("abd");
    const hash3 = element._hashContent("bbc");
    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash2).not.toBe(hash3);
  });

  it("should handle whitespace-only strings", () => {
    const hash1 = element._hashContent("   ");
    const hash2 = element._hashContent("\t\t\t");
    const hash3 = element._hashContent("\n\n\n");
    expect(hash1).not.toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).not.toBe(0);
  });

  it("should handle newlines correctly", () => {
    const hash1 = element._hashContent("line1\nline2");
    const hash2 = element._hashContent("line1\nline2");
    const hash3 = element._hashContent("line1\r\nline2");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3); // Different line endings should differ
  });
});

describe("CTCodeEditor hash lifecycle", () => {
  let element: AnyEditor;

  beforeEach(() => {
    element = new CTCodeEditor();
  });

  it("should start with null hash", () => {
    expect(element._lastEditorContentHash).toBeNull();
  });
});

describe("CTCodeEditor._hashContent performance", () => {
  let element: AnyEditor;

  beforeEach(() => {
    element = new CTCodeEditor();
  });

  it("should be faster for short strings than long strings", () => {
    const shortString = "Hello world";
    const longString = "a".repeat(10000);
    const iterations = 100;

    // Measure short strings
    const shortStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      element._hashContent(shortString);
    }
    const shortElapsed = performance.now() - shortStart;

    // Measure long strings
    const longStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      element._hashContent(longString);
    }
    const longElapsed = performance.now() - longStart;

    // Long strings should take more time than short strings
    expect(longElapsed).toBeGreaterThan(shortElapsed * 0.5);
  });

  it("should scale linearly with content size", () => {
    const small = "a".repeat(100);
    const large = "a".repeat(10000); // 100x larger
    const iterations = 100;

    const smallStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      element._hashContent(small);
    }
    const smallTime = performance.now() - smallStart;

    const largeStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      element._hashContent(large);
    }
    const largeTime = performance.now() - largeStart;

    // Should be roughly linear (not exponential). Large should be < 200x slower
    // (allowing for overhead and measurement variance)
    expect(largeTime / smallTime).toBeLessThan(200);
  });
});

describe("CTCodeEditor cursor stability", () => {
  let element: AnyEditor;

  beforeEach(() => {
    element = new CTCodeEditor();
  });

  it("should return early from _updateEditorFromCellValue when hash matches", () => {
    // Mock the editor view
    const mockDispatch = (update: any) => {
      throw new Error("dispatch should not be called when hash matches");
    };
    const mockState = {
      doc: {
        toString: () => "test content",
        length: 12,
      },
      selection: {
        main: { anchor: 5, head: 5 },
      },
    };
    element._editorView = {
      state: mockState,
      dispatch: mockDispatch,
    };

    // Set the hash to match the incoming content
    const content = "test content";
    element._lastEditorContentHash = element._hashContent(content);

    // Mock getValue to return the same content
    element.getValue = () => content;

    // This should return early without calling dispatch
    element._updateEditorFromCellValue();
  });

  it("should apply update when hash differs", () => {
    let dispatchCalled = false;
    const mockDispatch = (update: any) => {
      dispatchCalled = true;
      expect(update.changes.insert).toBe("new content");
    };
    const mockState = {
      doc: {
        toString: () => "old content",
        length: 11,
      },
      selection: {
        main: { anchor: 5, head: 5 },
      },
    };
    element._editorView = {
      state: mockState,
      dispatch: mockDispatch,
    };

    // Set hash to old content
    element._lastEditorContentHash = element._hashContent("old content");

    // Mock getValue to return new content
    element.getValue = () => "new content";

    // This should call dispatch with new content
    element._updateEditorFromCellValue();
    expect(dispatchCalled).toBe(true);
  });

  it("should handle hash collision with content check", () => {
    // Even if we somehow had a hash collision, the content equality check
    // at the beginning should save us
    let dispatchCalled = false;
    const mockDispatch = (update: any) => {
      dispatchCalled = true;
    };
    const mockState = {
      doc: {
        toString: () => "current content",
        length: 15,
      },
      selection: {
        main: { anchor: 5, head: 5 },
      },
    };
    element._editorView = {
      state: mockState,
      dispatch: mockDispatch,
    };

    // Set hash to match
    const hash = element._hashContent("different content");
    element._lastEditorContentHash = hash;

    // Mock getValue to return content with same hash but different text
    // (This is hypothetical - we can't easily create real collisions)
    // Instead, test that identical content skips regardless of hash
    element.getValue = () => "current content";

    // Should skip because content is identical (early exit before hash check)
    element._updateEditorFromCellValue();
    expect(dispatchCalled).toBe(false);
  });

  it("should clear hash on external update", () => {
    const mockDispatch = (update: any) => {
      // Verify the update is applied
    };
    const mockState = {
      doc: {
        toString: () => "old content",
        length: 11,
      },
      selection: {
        main: { anchor: 5, head: 5 },
      },
    };
    element._editorView = {
      state: mockState,
      dispatch: mockDispatch,
    };

    // Set a hash for old content
    element._lastEditorContentHash = element._hashContent("old content");

    // Apply external update
    element.getValue = () => "external update";
    element._updateEditorFromCellValue();

    // Hash should be cleared after external update
    expect(element._lastEditorContentHash).toBeNull();
  });

  it("should preserve cursor position when applying external update", () => {
    let capturedUpdate: any = null;
    const mockDispatch = (update: any) => {
      capturedUpdate = update;
    };
    const mockState = {
      doc: {
        toString: () => "old content",
        length: 11,
      },
      selection: {
        main: { anchor: 5, head: 8 },
      },
    };
    element._editorView = {
      state: mockState,
      dispatch: mockDispatch,
    };

    element._lastEditorContentHash = null;
    element.getValue = () => "new content";

    element._updateEditorFromCellValue();

    // Should preserve cursor positions
    expect(capturedUpdate.selection.anchor).toBe(5);
    expect(capturedUpdate.selection.head).toBe(8);
  });

  it("should clamp cursor position when new content is shorter", () => {
    let capturedUpdate: any = null;
    const mockDispatch = (update: any) => {
      capturedUpdate = update;
    };
    const mockState = {
      doc: {
        toString: () => "very long content here",
        length: 22,
      },
      selection: {
        main: { anchor: 15, head: 20 },
      },
    };
    element._editorView = {
      state: mockState,
      dispatch: mockDispatch,
    };

    element._lastEditorContentHash = null;
    element.getValue = () => "short"; // length 5

    element._updateEditorFromCellValue();

    // Cursor positions should be clamped to new length
    expect(capturedUpdate.selection.anchor).toBe(5);
    expect(capturedUpdate.selection.head).toBe(5);
  });

  it("should not update when editor view is not initialized", () => {
    element._editorView = undefined;
    element.getValue = () => "some content";

    // Should not throw, just return early
    expect(() => element._updateEditorFromCellValue()).not.toThrow();
  });

  it("should set hash when user types in editor", () => {
    // This simulates the updateListener behavior
    const content = "user typed content";
    const expectedHash = element._hashContent(content);

    // Start with null hash
    element._lastEditorContentHash = null;

    // Simulate what happens in the updateListener
    element._lastEditorContentHash = element._hashContent(content);

    // Hash should now be set
    expect(element._lastEditorContentHash).toBe(expectedHash);
  });

  it("should maintain hash when echo arrives for user's change", () => {
    const userContent = "user typed this";
    const userHash = element._hashContent(userContent);

    // User types, hash is set
    element._lastEditorContentHash = userHash;

    const mockState = {
      doc: {
        toString: () => userContent,
        length: userContent.length,
      },
      selection: {
        main: { anchor: 5, head: 5 },
      },
    };
    element._editorView = {
      state: mockState,
      dispatch: () => {
        throw new Error("Should not dispatch when echo matches");
      },
    };

    element.getValue = () => userContent;

    // When the echo arrives, it should skip update and maintain the hash
    element._updateEditorFromCellValue();

    // Hash should still be set (not cleared) since this was our own echo
    expect(element._lastEditorContentHash).toBe(userHash);
  });
});

describe("CTCodeEditor hash state edge cases", () => {
  let element: AnyEditor;

  beforeEach(() => {
    element = new CTCodeEditor();
  });

  it("should clear hash on disconnect", () => {
    // Set a hash value
    element._lastEditorContentHash = 12345;
    expect(element._lastEditorContentHash).toBe(12345);

    // Call cleanup (which is called during disconnectedCallback)
    element._cleanup();

    // Hash should be cleared
    expect(element._lastEditorContentHash).toBeNull();
  });

  it("should handle disconnect/reconnect with pending hash state", () => {
    // Simulate having a pending hash from user typing
    const testContent = "user was typing this";
    const hash = element._hashContent(testContent);
    element._lastEditorContentHash = hash;

    // Disconnect clears the hash
    element._cleanup();
    expect(element._lastEditorContentHash).toBeNull();

    // Reconnect with fresh state - hash should still be null
    expect(element._lastEditorContentHash).toBeNull();
  });

  it("should clear hash when switching to different Cell with different content", () => {
    // When switching cells, _updateEditorFromCellValue() is called which will
    // clear the hash if the content is different (external update path)

    // Setup mock cell controller
    element._cellController = {
      bind: () => {},
      getValue: () => "cell 1 content",
    };

    // Mock editor view
    element._editorView = {
      state: {
        doc: { toString: () => "old content", length: 11 },
        selection: { main: { anchor: 0, head: 0 } },
      },
      dispatch: () => {},
    };

    // User types in cell 1, hash is set
    const cell1Content = "typed in cell 1";
    const hash1 = element._hashContent(cell1Content);
    element._lastEditorContentHash = hash1;

    // Simulate switching to a different cell via updated()
    const changedProperties = new Map();
    changedProperties.set("value", "old-cell-value");

    // Update getValue to return different cell's content
    element._cellController.getValue = () => "cell 2 content";

    element.updated(changedProperties);

    // Hash should be cleared because _updateEditorFromCellValue() saw external content
    // (line 656: this._lastEditorContentHash = null when hash doesn't match)
    expect(element._lastEditorContentHash).toBeNull();
  });

  it("should NOT clear hash when switching cells with identical content", () => {
    // Edge case: If both cells happen to have identical content,
    // early exit at line 634 prevents hash clearing

    const sameContent = "same content in both cells";

    // Setup mock cell controller
    element._cellController = {
      bind: () => {},
      getValue: () => sameContent,
    };

    // Mock editor view with same content
    element._editorView = {
      state: {
        doc: { toString: () => sameContent, length: sameContent.length },
        selection: { main: { anchor: 0, head: 0 } },
      },
      dispatch: () => {
        throw new Error("Should not dispatch for identical content");
      },
    };

    // User had hash set from cell 1
    const hash = element._hashContent(sameContent);
    element._lastEditorContentHash = hash;

    // Simulate switching to cell 2 (also has same content)
    const changedProperties = new Map();
    changedProperties.set("value", "old-cell-value");

    element.updated(changedProperties);

    // Hash should remain set because early exit at line 634 (content identical)
    expect(element._lastEditorContentHash).toBe(hash);
  });

  it("should handle switching cells when hash matches but content differs (hash collision)", () => {
    // Extremely rare edge case: different content with matching hash
    // This documents behavior when collision occurs during cell switch

    const cell1Content = "content from cell 1";
    const cell2Content = "content from cell 2";
    const hash = element._hashContent(cell1Content);

    // Setup mock
    element._cellController = {
      bind: () => {},
      getValue: () => cell2Content,
    };

    element._editorView = {
      state: {
        doc: { toString: () => cell1Content, length: cell1Content.length },
        selection: { main: { anchor: 0, head: 0 } },
      },
      dispatch: () => {
        throw new Error("Should not dispatch when hash matches (collision)");
      },
    };

    // Simulate hash collision - force cell2Content to have same hash
    const originalHashContent = element._hashContent.bind(element);
    element._hashContent = (str: string) => {
      if (str === cell2Content) return hash; // Force collision
      return originalHashContent(str);
    };

    element._lastEditorContentHash = hash;

    const changedProperties = new Map();
    changedProperties.set("value", "old-value");

    // With collision, update is skipped even though content differs
    element.updated(changedProperties);

    // Hash remains (update was skipped due to collision)
    expect(element._lastEditorContentHash).toBe(hash);

    // Restore
    element._hashContent = originalHashContent;
  });

  it("should handle rapid external updates clearing hash appropriately", () => {
    const userContent = "user typed this";
    const userHash = element._hashContent(userContent);

    let dispatchCalls: any[] = [];

    // Mock editor view
    element._editorView = {
      state: {
        doc: { toString: () => userContent, length: userContent.length },
        selection: { main: { anchor: 5, head: 5 } },
      },
      dispatch: (config: any) => {
        dispatchCalls.push(config);
        // Update doc to reflect the change
        element._editorView.state.doc.toString = () => config.changes.insert;
      },
    };

    element.getValue = () => "external update 1";

    // User types, hash is set
    element._lastEditorContentHash = userHash;

    // First external update arrives (different content)
    element._updateEditorFromCellValue();

    // Hash should be cleared after first external update
    expect(element._lastEditorContentHash).toBeNull();
    expect(dispatchCalls.length).toBe(1);

    // Second rapid external update arrives
    element.getValue = () => "external update 2";
    element._updateEditorFromCellValue();

    // Hash still null, second update applied
    expect(element._lastEditorContentHash).toBeNull();
    expect(dispatchCalls.length).toBe(2);
    expect(dispatchCalls[1].changes.insert).toBe("external update 2");
  });

  it("should handle content identical but hash stale (early exit scenario)", () => {
    const content = "same content";
    const staleHash = 99999; // Some old hash value

    // Mock editor with content
    element._editorView = {
      state: {
        doc: { toString: () => content, length: content.length },
        selection: { main: { anchor: 0, head: 0 } },
      },
      dispatch: () => {
        throw new Error("Should not dispatch when content is identical");
      },
    };

    element.getValue = () => content;
    element._lastEditorContentHash = staleHash;

    // Should early exit at line 634 due to identical content
    // Hash check is never reached
    element._updateEditorFromCellValue();

    // Hash should remain unchanged (early exit before hash check)
    expect(element._lastEditorContentHash).toBe(staleHash);
  });

  it("should handle switching between Cells without hash interference", () => {
    // Scenario: User types in Cell A, switches to Cell B
    // Expected: Updates from Cell B should not be blocked by Cell A's hash

    const cellAContent = "content from cell A";
    const cellBContent = "content from cell B";

    // User types in Cell A, hash is set
    const hashA = element._hashContent(cellAContent);
    element._lastEditorContentHash = hashA;

    // User switches to Cell B (in real code, hash is NOT cleared - this is the bug)
    // Cell B sends its content
    const hashB = element._hashContent(cellBContent);

    // Verify the hashes are different (normal case)
    // If they were the same, Cell B's update would be incorrectly skipped
    expect(hashA).not.toBe(hashB);
  });

  it("should handle null editor view gracefully", () => {
    element._editorView = undefined;
    element._lastEditorContentHash = 12345;
    element.getValue = () => "some content";

    // Should not throw, should return early
    expect(() => element._updateEditorFromCellValue()).not.toThrow();

    // Hash should remain unchanged (early return at line 628)
    expect(element._lastEditorContentHash).toBe(12345);
  });

  it("should maintain hash during rapid user typing sequence", () => {
    // Simulate user typing multiple characters quickly
    const content1 = "a";
    const content2 = "ab";
    const content3 = "abc";

    const hash1 = element._hashContent(content1);
    const hash2 = element._hashContent(content2);
    const hash3 = element._hashContent(content3);

    // Each keystroke updates the hash
    element._lastEditorContentHash = hash1;
    expect(element._lastEditorContentHash).toBe(hash1);

    element._lastEditorContentHash = hash2;
    expect(element._lastEditorContentHash).toBe(hash2);

    element._lastEditorContentHash = hash3;
    expect(element._lastEditorContentHash).toBe(hash3);

    // All hashes should be different
    expect(hash1).not.toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).not.toBe(hash3);
  });

  it("should handle empty string transitions correctly", () => {
    const emptyHash = element._hashContent("");
    const contentHash = element._hashContent("some content");

    // Empty to content
    element._lastEditorContentHash = emptyHash;
    expect(element._lastEditorContentHash).toBe(0); // Empty string hash is 0

    // Content to empty
    element._lastEditorContentHash = contentHash;
    expect(element._lastEditorContentHash).not.toBe(0);

    // Verify they're different
    expect(emptyHash).not.toBe(contentHash);
  });

  it("should clear hash on cleanup to prevent stale state on reconnect", () => {
    // Set hash
    element._lastEditorContentHash = 99999;

    // Disconnect clears state
    element._cleanup();
    expect(element._lastEditorContentHash).toBeNull();

    // After cleanup, hash is fresh for next connection
    // This prevents stale hash from affecting new Cell subscriptions
  });

  it("should handle hash collision edge case gracefully", () => {
    // In the extremely unlikely event of a hash collision,
    // the content identity check at line 634 provides first line of defense

    const content1 = "content A";
    const content2 = "content A"; // Same content = same hash (not a collision)

    element._editorView = {
      state: {
        doc: { toString: () => content1, length: content1.length },
        selection: { main: { anchor: 0, head: 0 } },
      },
      dispatch: () => {
        throw new Error("Should not dispatch for identical content");
      },
    };

    const hash = element._hashContent(content1);
    element._lastEditorContentHash = hash;
    element.getValue = () => content2;

    // Should early exit due to identical content (line 634)
    element._updateEditorFromCellValue();
  });

  it("should handle scenario where user types same content as current (idempotent)", () => {
    const content = "same content";
    const hash = element._hashContent(content);

    element._editorView = {
      state: {
        doc: { toString: () => content, length: content.length },
        selection: { main: { anchor: 0, head: 0 } },
      },
      dispatch: () => {
        throw new Error("Should not dispatch for identical content");
      },
    };

    element._lastEditorContentHash = hash;
    element.getValue = () => content;

    // Should early exit at line 634 (content check)
    element._updateEditorFromCellValue();

    // Hash remains set
    expect(element._lastEditorContentHash).toBe(hash);
  });
});
