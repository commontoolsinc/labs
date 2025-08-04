import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Node, Tree } from "./types.ts";
import { getNodePath, getNodeByPath } from "./node-path.ts";

describe("CTOutliner Path-based Node Finding (CT-693)", () => {
  // Helper to create a test tree
  function createTestTree(): Tree {
    return {
      root: {
        body: "Root",
        children: [
          {
            body: "Child 1",
            children: [
              {
                body: "Grandchild 1.1",
                children: [],
                attachments: [],
              },
              {
                body: "Grandchild 1.2",
                children: [],
                attachments: [],
              },
            ],
            attachments: [],
          },
          {
            body: "Child 2",
            children: [],
            attachments: [],
          },
        ],
        attachments: [],
      },
    };
  }

  // Tests now use the extracted functions from node-path.ts

  it("should find correct path to nodes", () => {
    const tree = createTestTree();

    // Test root
    const rootPath = getNodePath(tree, tree.root);
    expect(rootPath).toEqual([]);

    // Test first child
    const child1 = tree.root.children[0];
    const child1Path = getNodePath(tree, child1);
    expect(child1Path).toEqual([0]);

    // Test grandchild
    const grandchild = tree.root.children[0].children[1];
    const grandchildPath = getNodePath(tree, grandchild);
    expect(grandchildPath).toEqual([0, 1]);
  });

  it("should navigate to nodes using paths", () => {
    const tree = createTestTree();

    // Navigate to root
    const rootNode = getNodeByPath(tree, []);
    expect(rootNode).toBe(tree.root);

    // Navigate to child
    const childNode = getNodeByPath(tree, [0]);
    expect(childNode?.body).toBe("Child 1");

    // Navigate to grandchild
    const grandchildNode = getNodeByPath(tree, [0, 1]);
    expect(grandchildNode?.body).toBe("Grandchild 1.2");
  });

  it("should handle path-based navigation after tree modification", () => {
    const tree = createTestTree();

    // Get initial reference and path to grandchild
    const grandchild = tree.root.children[0].children[1];
    const grandchildPath = getNodePath(tree, grandchild);
    expect(grandchildPath).toEqual([0, 1]);

    // Simulate tree modification (like what happens with Cell updates)
    // Create a new tree with updated content but same structure
    const modifiedTree: Tree = {
      root: {
        body: "Root (modified)",
        children: [
          {
            body: "Child 1 (modified)",
            children: [
              {
                body: "Grandchild 1.1",
                children: [],
                attachments: [],
              },
              {
                body: "Grandchild 1.2", // This is what we want to edit
                children: [],
                attachments: [],
              },
            ],
            attachments: [],
          },
          {
            body: "Child 2",
            children: [],
            attachments: [],
          },
        ],
        attachments: [],
      },
    };

    // The old grandchild reference is now stale
    const stillFoundByReference = getNodePath(modifiedTree, grandchild);
    expect(stillFoundByReference).toBeNull(); // Can't find by reference!

    // But we can still navigate using the path
    const nodeByPath = getNodeByPath(modifiedTree, grandchildPath!);
    expect(nodeByPath).not.toBeNull();
    expect(nodeByPath?.body).toBe("Grandchild 1.2");

    // This demonstrates why storing paths is more reliable than storing node references
  });

  it("should demonstrate the fix for CT-693", () => {
    const tree = createTestTree();

    // Simulate starting to edit a grandchild node
    const editingNode = tree.root.children[0].children[1];
    const editingNodePath = getNodePath(tree, editingNode);
    const editingContent = "Updated content";

    // Simulate tree update (Cell operation that creates new objects)
    const updatedTree: Tree = JSON.parse(JSON.stringify(tree)); // Deep clone

    // Old approach: try to find node by reference (FAILS)
    const nodeByReference = getNodePath(updatedTree, editingNode);
    expect(nodeByReference).toBeNull();

    // New approach: use stored path (WORKS)
    const nodeByPath = getNodeByPath(updatedTree, editingNodePath!);
    expect(nodeByPath).not.toBeNull();

    // We can now update the correct node
    nodeByPath!.body = editingContent;
    expect(updatedTree.root.children[0].children[1].body).toBe(
      "Updated content",
    );
  });
});
