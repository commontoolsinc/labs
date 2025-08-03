import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Node, Tree } from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";
import { CTOutliner } from "./ct-outliner.ts";
import { createMockTreeCell } from "./test-utils.ts";

describe("CT-693 Rendering Fix Tests", () => {
  // Helper to create a test tree
  function createTestTree(): Tree {
    return {
      root: {
        body: "Root",
        children: [
          {
            body: "First child",
            children: [],
            attachments: [],
          },
        ],
        attachments: [],
      },
    };
  }

  async function createOutliner(tree: Tree): Promise<CTOutliner> {
    const outliner = new CTOutliner();
    const mockCell = await createMockTreeCell(tree);
    outliner.value = mockCell;
    return outliner;
  }

  it("should render newly created nodes without getNodePath returning null", async () => {
    const tree = createTestTree();
    const outliner = await createOutliner(tree);
    
    // Get the first child node
    const firstChild = tree.root.children[0];
    
    // Create a new node that would previously fail to render
    const newNode = TreeOperations.createNode({ body: "New child" });
    
    // Simulate the node being added to the tree structure
    tree.root.children.push(newNode);
    
    // The key issue was that getNodePath would return null for newly created nodes
    // causing renderNode to return null. With our fix, renderNode should use
    // calculated paths instead.
    
    // Test our fix: renderNode should work with calculated paths
    const calculatedPath = [1]; // Second child of root
    const rendered = (outliner as any).renderNode(newNode, 0, calculatedPath);
    
    // Should not return null
    expect(rendered).not.toBe(null);
    expect(rendered).not.toBe(undefined);
  });

  it("should handle multiple child nodes being added without rendering issues", async () => {
    const tree = createTestTree();
    const outliner = await createOutliner(tree);
    
    // Add multiple children to simulate the issue where only one child could be added to root
    const child1 = TreeOperations.createNode({ body: "Child 1" });
    const child2 = TreeOperations.createNode({ body: "Child 2" });
    const child3 = TreeOperations.createNode({ body: "Child 3" });
    
    tree.root.children.push(child1, child2, child3);
    
    // Test that all nodes can be rendered with calculated paths
    const rendered1 = (outliner as any).renderNode(child1, 0, [1]);
    const rendered2 = (outliner as any).renderNode(child2, 0, [2]);
    const rendered3 = (outliner as any).renderNode(child3, 0, [3]);
    
    expect(rendered1).not.toBe(null);
    expect(rendered2).not.toBe(null);
    expect(rendered3).not.toBe(null);
  });

  it("should render sub-child nodes that are added to the data structure", async () => {
    const tree = createTestTree();
    const outliner = await createOutliner(tree);

    // Get the first child and add sub-children
    const firstChild = tree.root.children[0];
    const subChild1 = TreeOperations.createNode({ body: "Sub child 1" });
    const subChild2 = TreeOperations.createNode({ body: "Sub child 2" });

    firstChild.children.push(subChild1, subChild2);

    // Test that sub-children can be rendered with calculated paths
    const rendered1 = (outliner as any).renderNode(subChild1, 1, [0, 0]);
    const rendered2 = (outliner as any).renderNode(subChild2, 1, [0, 1]);

    expect(rendered1).not.toBe(null);
    expect(rendered2).not.toBe(null);
  });

  it("should support the new path-based renderNodes method", async () => {
    const tree = createTestTree();
    const outliner = await createOutliner(tree);

    // Add some children to test with
    const child1 = TreeOperations.createNode({ body: "Child 1" });
    const child2 = TreeOperations.createNode({ body: "Child 2" });
    tree.root.children.push(child1, child2);

    // Test the new renderNodes signature with parentPath parameter
    const nodes = tree.root.children;
    const rendered = (outliner as any).renderNodes(nodes, 0, []);

    // Should return rendered content without throwing errors
    expect(rendered).not.toBe(null);
    expect(rendered).not.toBe(undefined);
  });

  it("should handle createNewNodeAfter with path-based approach", async () => {
    const tree = createTestTree();
    const outliner = await createOutliner(tree);

    const firstChild = tree.root.children[0];

    // Before the fix, this would fail because getNodePath would return null
    // for the newly created node, causing focus/editing issues
    await outliner.createNewNodeAfter(firstChild);

    // Check that the focused node path was set correctly (should be [1] for second child of root)
    expect(outliner.focusedNodePath).toEqual([1]);

    // Check that editing was started correctly
    expect(outliner.testAPI.editingNodePath).toEqual([1]);
    expect(outliner.testAPI.editingContent).toBe("");
  });

  it("should handle createChildNode with path-based approach", async () => {
    const tree = createTestTree();
    const outliner = await createOutliner(tree);

    const firstChild = tree.root.children[0];

    // Before the fix, this would fail for the same reason as createNewNodeAfter
    await outliner.createChildNode(firstChild);

    // Check that the focused node path was set correctly (should be [0, 0] for first child of first child)
    expect(outliner.focusedNodePath).toEqual([0, 0]);

    // Check that editing was started correctly
    expect(outliner.testAPI.editingNodePath).toEqual([0, 0]);
    expect(outliner.testAPI.editingContent).toBe("");
  });

  it("should handle getNodePath returning null gracefully", async () => {
    const tree = createTestTree();
    const outliner = await createOutliner(tree);

    // Create a node that's not in the tree
    const orphanNode = TreeOperations.createNode({ body: "Orphan" });

    // getNodePath should return null for nodes not in the tree
    const path = (outliner as any).getNodePath(orphanNode);
    expect(path).toBe(null);

    // But our renderNode method should handle this gracefully by using calculated paths
    // instead of calling getNodePath directly
  });

  it("should demonstrate the fix: nodes are rendered even when getNodePath would fail", async () => {
    const tree = createTestTree();
    const outliner = await createOutliner(tree);

    // This test demonstrates the core fix: even if a node reference becomes stale
    // (which would cause getNodePath to return null), the rendering system should
    // still work because it uses calculated paths passed down from the parent.

    const originalChild = tree.root.children[0];

    // Simulate a tree update that would make the old reference stale
    const newTree: Tree = JSON.parse(JSON.stringify(tree)); // Deep clone
    newTree.root.children[0].body = "Updated first child";

    // Update the outliner's tree
    (outliner as any).value.set(newTree);

    // The old reference would now return null from getNodePath
    const pathOfStaleReference = (outliner as any).getNodePath(originalChild);
    expect(pathOfStaleReference).toBe(null);

    // But the new renderNode approach should still work because it doesn't rely on getNodePath
    const newChild = newTree.root.children[0];
    const rendered = (outliner as any).renderNode(newChild, 0, [0]);

    expect(rendered).not.toBe(null);
    expect(rendered).not.toBe(undefined);
  });
});