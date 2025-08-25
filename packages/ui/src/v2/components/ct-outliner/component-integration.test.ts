import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTOutliner } from "./ct-outliner.ts";
import {
  createMockTreeCell,
  createNestedTestTree,
  setupMockOutliner,
  waitForOutlinerUpdate,
} from "./test-utils.ts";
import { getNodeByPath } from "./node-path.ts";

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

      const result = await outliner.createNodeAfterPath(
        outliner.focusedNodePath!,
        { body: "" },
      );

      expect(outliner.tree.root.children.length).toBe(initialCount + 1);
      expect(result.success).toBe(true);
      const focusedNode = outliner.focusedNodePath
        ? getNodeByPath(outliner.tree, outliner.focusedNodePath)
        : null;
      expect(focusedNode?.body).toBe("");
    });

    it("should create child node with Shift+Enter equivalent", async () => {
      await setupOutliner();
      const parentPath = outliner.focusedNodePath!;
      const parentNode = getNodeByPath(outliner.tree, parentPath);
      if (!parentNode) throw new Error("Parent node not found");
      const initialChildCount = parentNode.children.length;

      const result = await outliner.createChildNodeAtPath(parentPath, {
        body: "",
      });

      // Since tree is mutable, parentNode should have the new child
      const updatedParent = getNodeByPath(outliner.tree, parentPath);
      if (!updatedParent) throw new Error("Updated parent not found");
      expect(updatedParent.children.length).toBe(initialChildCount + 1);
      expect(result.success).toBe(true);
      const focusedNode = outliner.focusedNodePath
        ? getNodeByPath(outliner.tree, outliner.focusedNodePath)
        : null;
      expect(focusedNode?.body).toBe("");
    });
  });

  describe("Node Deletion", () => {
    it("should delete node and update focus", async () => {
      await setupOutliner();
      const pathToDelete = [0]; // First child
      const secondNodeBody = outliner.tree.root.children[1].body;

      const result = await outliner.deleteNodeByPath(pathToDelete);
      await waitForOutlinerUpdate(outliner);

      expect(result.success).toBe(true);
      expect(outliner.tree.root.children.length).toBe(1);
      // Compare node properties instead of object identity
      expect(outliner.tree.root.children[0].body).toBe(secondNodeBody);
    });
  });

  describe("Node Indentation", () => {
    it("should indent node correctly", async () => {
      await setupOutliner();
      const secondNodeBody = outliner.tree.root.children[1].body;
      const secondNodePath = [1]; // Second child

      const result = await outliner.indentNodeByPath(secondNodePath);
      await waitForOutlinerUpdate(outliner);

      expect(result.success).toBe(true);
      expect(outliner.tree.root.children.length).toBe(1);
      // Get fresh reference to first node after operation
      const firstNode = outliner.tree.root.children[0];
      expect(firstNode.children.length).toBe(1);
      // Compare node properties instead of object identity
      expect(firstNode.children[0].body).toBe(secondNodeBody);
    });

    it("should outdent node correctly", async () => {
      const tree = createNestedTestTree();
      const treeCell = await createMockTreeCell(tree);
      outliner.value = treeCell;
      // Use path from outliner.tree instead of node reference
      const childNodePath = [0, 0]; // First child of first node
      const childNode = getNodeByPath(outliner.tree, childNodePath);
      if (!childNode) throw new Error("Child node not found");
      const childNodeBody = childNode.body;

      const result = await outliner.outdentNodeByPath(childNodePath);
      await waitForOutlinerUpdate(outliner);

      expect(result.success).toBe(true);
      expect(outliner.tree.root.children.length).toBe(2);
      // Compare node properties instead of object identity
      expect(outliner.tree.root.children[1].body).toBe(childNodeBody);
    });
  });

  describe("Editing Mode", () => {
    it("should enter edit mode and preserve content", async () => {
      await setupOutliner();
      const focusedPath = outliner.focusedNodePath!;
      const node = getNodeByPath(outliner.tree, focusedPath);
      if (!node) throw new Error("Focused node not found");

      // Start editing with the node's body as initial content
      outliner.startEditingByPath(focusedPath, node.body);

      // First, check that editing mode is activated
      expect(outliner.testAPI.editingNodePath).toEqual(focusedPath);
      expect(outliner.testAPI.editingNode).toBe(node);

      // Check that content is properly set
      expect(outliner.testAPI.editingContent).toBe(node.body);
    });

    it("should start editing with initial text", async () => {
      await setupOutliner();
      const focusedPath = outliner.focusedNodePath!;
      const node = getNodeByPath(outliner.tree, focusedPath);
      const initialText = "Hello";

      outliner.startEditingWithInitialTextByPath(focusedPath, initialText);

      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe(initialText);
    });
  });

  describe("Tree Structure Integrity", () => {
    it("should preserve node content after operations", async () => {
      await setupOutliner();
      const originalFirstNodeBody = outliner.tree.root.children[0].body;
      const originalSecondNodeBody = outliner.tree.root.children[1].body;
      const firstNodePath = [0];

      // Create a new node
      const result = await outliner.createNodeAfterPath(firstNodePath, {
        body: "",
      });
      await waitForOutlinerUpdate(outliner);

      // Original nodes should still be present and identifiable by content
      expect(result.success).toBe(true);
      expect(outliner.tree.root.children[0].body).toBe(originalFirstNodeBody);
      expect(outliner.tree.root.children[2].body).toBe(originalSecondNodeBody);
      expect(outliner.tree.root.children.length).toBe(3);
    });

    it("should maintain focus correctly after tree modifications", async () => {
      await setupOutliner();
      const firstNodePath = [0];
      const firstNode = getNodeByPath(outliner.tree, firstNodePath);

      // Create new node and verify focus is on new node
      const result = await outliner.createNodeAfterPath(firstNodePath, {
        body: "",
      });

      expect(result.success).toBe(true);
      const focusedNode = outliner.focusedNodePath
        ? getNodeByPath(outliner.tree, outliner.focusedNodePath)
        : null;
      expect(focusedNode?.body).toBe("");
      expect(focusedNode).not.toBe(firstNode);
    });
  });

  describe("Public API Methods", () => {
    it("should have all required public methods accessible", async () => {
      await setupOutliner();

      expect(typeof outliner.createNodeAfterPath).toBe("function");
      expect(typeof outliner.createChildNodeAtPath).toBe("function");
      expect(typeof outliner.deleteNodeByPath).toBe("function");
      expect(typeof outliner.indentNodeByPath).toBe("function");
      expect(typeof outliner.outdentNodeByPath).toBe("function");
      expect(typeof outliner.startEditingByPath).toBe("function");
      expect(typeof outliner.startEditingWithInitialTextByPath).toBe(
        "function",
      );
      expect(typeof outliner.setNodeCheckboxByPath).toBe("function");
      expect(typeof outliner.emitChange).toBe("function");
    });
  });

  describe("Edit Mode State Management", () => {
    it("should toggle edit mode correctly", async () => {
      await setupOutliner();
      const focusedPath = outliner.focusedNodePath!;
      const node = getNodeByPath(outliner.tree, focusedPath);

      // Should start editing
      outliner.startEditingByPath(focusedPath);
      expect(outliner.testAPI.editingNode).toBe(node);

      // Should stop editing
      outliner.cancelEditing();
      expect(outliner.testAPI.editingNode).toBe(null);
    });

    it("should handle switching edit mode between different nodes", async () => {
      await setupOutliner();
      const firstNodePath = [0];
      const secondNodePath = [1];
      const firstNode = getNodeByPath(outliner.tree, firstNodePath);
      const secondNode = getNodeByPath(outliner.tree, secondNodePath);
      if (!firstNode || !secondNode) throw new Error("Nodes not found");

      // Start editing first node
      outliner.startEditingByPath(firstNodePath, firstNode.body);
      expect(outliner.testAPI.editingNode).toBe(firstNode);

      // Switch to editing second node (should stop editing first)
      outliner.startEditingByPath(secondNodePath, secondNode.body);
      expect(outliner.testAPI.editingNode).toBe(secondNode);
      expect(outliner.testAPI.editingContent).toBe(secondNode.body);
    });
  });
});
