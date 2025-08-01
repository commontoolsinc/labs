import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTOutliner } from "./ct-outliner.ts";
import {
  createMockTreeCell,
  createNestedTestTree,
  setupMockOutliner,
} from "./test-utils.ts";

describe("CTOutliner Component Integration Tests", () => {
  let outliner: CTOutliner;

  async function setupOutliner() {
    const setup = await setupMockOutliner();
    outliner = setup.outliner;
    return setup;
  }

  describe("Node Creation", () => {
    it("should create new sibling node with Enter", async () => {
      await setupOutliner();
      const initialCount = outliner.tree.root.children.length;

      outliner.createNewNodeAfter(outliner.focusedNode!);

      expect(outliner.tree.root.children.length).toBe(initialCount + 1);
      expect(outliner.focusedNode!.body).toBe("");
    });

    it("should create child node with Shift+Enter equivalent", async () => {
      await setupOutliner();
      const parentNode = outliner.focusedNode!;
      const initialChildCount = parentNode.children.length;

      outliner.createChildNode(parentNode);

      // Since tree is mutable, parentNode should have the new child
      expect(parentNode.children.length).toBe(initialChildCount + 1);
      expect(outliner.focusedNode!.body).toBe("");
    });
  });

  describe("Node Deletion", () => {
    it("should delete node and update focus", async () => {
      await setupOutliner();
      const nodeToDelete = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];

      outliner.deleteNode(nodeToDelete);

      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0]).toBe(secondNode);
    });
  });

  describe("Node Indentation", () => {
    it("should indent node correctly", async () => {
      await setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];

      outliner.indentNode(secondNode);

      expect(outliner.tree.root.children.length).toBe(1);
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);
    });

    it("should outdent node correctly", async () => {
      const tree = createNestedTestTree();
      const treeCell = await createMockTreeCell(tree);
      outliner.value = treeCell;
      const childNode = tree.root.children[0].children[0];

      outliner.outdentNode(childNode);

      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[1]).toBe(childNode);
    });
  });

  describe("Editing Mode", () => {
    it("should enter edit mode and preserve content", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;

      outliner.startEditing(node);

      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe(node.body);
    });

    it("should start editing with initial text", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;
      const initialText = "Hello";

      outliner.startEditingWithInitialText(node, initialText);

      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe(initialText);
    });
  });

  describe("Tree Structure Integrity", () => {
    it("should preserve node references after operations", async () => {
      await setupOutliner();
      const originalFirstNode = outliner.tree.root.children[0];
      const originalSecondNode = outliner.tree.root.children[1];

      // Create a new node
      outliner.createNewNodeAfter(originalFirstNode);

      // Original nodes should still be present and identifiable
      expect(outliner.tree.root.children[0]).toBe(originalFirstNode);
      expect(outliner.tree.root.children[2]).toBe(originalSecondNode);
    });

    it("should maintain focus correctly after tree modifications", async () => {
      await setupOutliner();
      const firstNode = outliner.tree.root.children[0];

      // Create new node and verify focus is on new node
      outliner.createNewNodeAfter(firstNode);
      expect(outliner.focusedNode!.body).toBe("");
      expect(outliner.focusedNode).not.toBe(firstNode);
    });
  });

  describe("Public API Methods", () => {
    it("should have all required public methods accessible", async () => {
      await setupOutliner();

      expect(typeof outliner.createNewNodeAfter).toBe("function");
      expect(typeof outliner.createChildNode).toBe("function");
      expect(typeof outliner.deleteNode).toBe("function");
      expect(typeof outliner.indentNode).toBe("function");
      expect(typeof outliner.outdentNode).toBe("function");
      expect(typeof outliner.startEditing).toBe("function");
      expect(typeof outliner.startEditingWithInitialText).toBe("function");
      expect(typeof outliner.toggleEditMode).toBe("function");
      expect(typeof outliner.emitChange).toBe("function");
    });
  });

  describe("Edit Mode State Management", () => {
    it("should toggle edit mode correctly", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;

      // Should start editing
      outliner.toggleEditMode(node);
      expect(outliner.testAPI.editingNode).toBe(node);

      // Should stop editing
      outliner.toggleEditMode(node);
      expect(outliner.testAPI.editingNode).toBe(null);
    });

    it("should handle switching edit mode between different nodes", async () => {
      await setupOutliner();
      const firstNode = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];

      // Start editing first node
      outliner.toggleEditMode(firstNode);
      expect(outliner.testAPI.editingNode).toBe(firstNode);

      // Switch to editing second node (should stop editing first)
      outliner.toggleEditMode(secondNode);
      expect(outliner.testAPI.editingNode).toBe(secondNode);
      expect(outliner.testAPI.editingContent).toBe(secondNode.body);
    });
  });
});
