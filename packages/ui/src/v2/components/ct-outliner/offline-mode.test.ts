import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTOutliner } from "./ct-outliner.ts";
import { setupMockOutliner } from "./test-utils.ts";

describe("CTOutliner Offline Mode", () => {
  let outliner: CTOutliner;

  function setupOutliner() {
    const setup = setupMockOutliner();
    outliner = setup.outliner;
    return setup;
  }

  describe("Offline Mode Toggle", () => {
    it("should start with offline mode disabled", () => {
      setupOutliner();
      expect(outliner.offline).toBe(false);
    });

    it("should toggle offline mode", () => {
      setupOutliner();
      outliner.offline = true;
      expect(outliner.offline).toBe(true);
    });
  });

  describe("Event Emission in Offline Mode", () => {
    it("should not update value property when offline", () => {
      setupOutliner();
      const originalValue = outliner.value;

      // Modify the tree
      outliner.tree.root.children[0].body = "Modified";

      // Enable offline mode and emit change
      outliner.offline = true;
      outliner.emitChange();

      // Value should not have been updated
      expect(outliner.value).toBe(originalValue);
    });

    it("should update value property when online", () => {
      setupOutliner();
      const originalValue = outliner.value;

      // Modify the tree
      outliner.tree.root.children[0].body = "Modified";

      // Keep offline mode disabled and emit change
      outliner.offline = false;
      outliner.emitChange();

      // Value should have been updated
      expect(outliner.value).not.toBe(originalValue);
      expect(outliner.tree.root.children[0].body).toBe("Modified");
    });
  });

  describe("Debug Panel", () => {
    it("should start with debug panel hidden", () => {
      setupOutliner();
      expect(outliner.showDebugPanel).toBe(false);
    });

    it("should toggle debug panel", () => {
      setupOutliner();
      outliner.showDebugPanel = true;
      expect(outliner.showDebugPanel).toBe(true);
    });

    it("should toggle debug panel with button click", () => {
      setupOutliner();
      expect(outliner.showDebugPanel).toBe(false);

      // Simulate clicking the debug toggle button
      outliner.showDebugPanel = !outliner.showDebugPanel;
      expect(outliner.showDebugPanel).toBe(true);

      // Click again to hide
      outliner.showDebugPanel = !outliner.showDebugPanel;
      expect(outliner.showDebugPanel).toBe(false);
    });
  });

  describe("Tree Isolation in Offline Mode", () => {
    it("should deep clone tree when entering offline mode", () => {
      setupOutliner();
      const originalTree = outliner.tree;
      const originalFirstNode = outliner.tree.root.children[0];

      // Enter offline mode
      outliner.offline = true;

      // Tree should be different object (cloned)
      expect(outliner.tree).not.toBe(originalTree);
      expect(outliner.tree.root.children[0]).not.toBe(originalFirstNode);

      // But content should be the same
      expect(outliner.tree.root.children[0].body).toBe(originalFirstNode.body);
      expect(outliner.tree.root.children.length).toBe(
        originalTree.root.children.length,
      );
    });

    it("should update focused node reference after cloning", () => {
      setupOutliner();
      const originalFocusedNode = outliner.focusedNode;

      // Enter offline mode
      outliner.offline = true;

      // Focused node should be different object but same content
      expect(outliner.focusedNode).not.toBe(originalFocusedNode);
      expect(outliner.focusedNode?.body).toBe(originalFocusedNode?.body);
    });

    it("should handle cloning failure gracefully", () => {
      setupOutliner();

      // Create a circular reference that can't be JSON.stringify'd
      const circularNode = outliner.tree.root.children[0];
      (circularNode as any).circular = circularNode;

      // Should not throw and should successfully handle circular references
      outliner.offline = true;
      expect(outliner.offline).toBe(true);
    });
  });

  describe("Tree Reset Functionality", () => {
    it("should reset tree to a clean default state", () => {
      setupOutliner();

      // Modify the tree to a broken state
      outliner.tree.root.children = [];
      outliner.focusedNode = null;

      // Reset the tree
      outliner.testAPI.handleReset();

      // Should have a clean state with default content
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[0].body).toBe(
        "Welcome! Start typing here...",
      );
      expect(outliner.focusedNode).toBe(outliner.tree.root.children[0]);
      expect(outliner.collapsedNodes.size).toBe(0);
    });

    it("should clear editing state when resetting", () => {
      setupOutliner();

      // Set some editing state
      outliner.testAPI.startEditing(outliner.tree.root.children[0]);
      expect(outliner.testAPI.editingNode).not.toBe(null);

      // Reset the tree
      outliner.testAPI.handleReset();

      // Editing state should be cleared
      expect(outliner.testAPI.editingNode).toBe(null);
      expect(outliner.testAPI.editingContent).toBe("");
    });

    it("should work in offline mode without emitting changes", () => {
      setupOutliner();

      // Track if emitChange was called by checking if value property changes
      const originalValue = outliner.value;

      // Enable offline mode and reset
      outliner.offline = true;
      outliner.testAPI.handleReset();

      // Value should not change in offline mode
      expect(outliner.value).toBe(originalValue);
    });
  });
});
