import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TreeOperations } from "./tree-operations.ts";
import { createMockTreeCell } from "./test-utils.ts";
import { ID } from "@commontools/runner";

describe("Debug Cell movement", () => {
  it("should test if nodes have [ID]", async () => {
    const tree = {
      root: TreeOperations.createNode({
        body: "Root",
        children: [
          TreeOperations.createNode({ body: "Item 1" }),
          TreeOperations.createNode({ body: "Item 2" }),
        ],
      }),
    };

    // Check initial tree structure
    console.log("Initial tree children[0] has ID?", ID in tree.root.children[0]);
    console.log("Initial tree children[0] ID:", tree.root.children[0][ID]);
    
    const treeCell = await createMockTreeCell(tree);
    const rootCell = treeCell.key("root");
    const childrenCell = rootCell.key("children");
    
    // Check if nodes have [ID] after Cell creation
    const children = childrenCell.get();
    console.log("After Cell - Child 0 has ID?", ID in children[0]);
    console.log("After Cell - Child 0 ID value:", children[0][ID]);
    console.log("After Cell - Child 1 has ID?", ID in children[1]);
    console.log("After Cell - Child 1 ID value:", children[1][ID]);

    // Try the operation
    const result = await TreeOperations.indentNodeCell(rootCell, [1]);
    console.log("Indent operation result:", result);

    // Check the tree after
    const updatedTree = treeCell.get();
    console.log("Tree after indent:", JSON.stringify(updatedTree, null, 2));
    
    expect(result).toBeTruthy();
  });

  it("should test outdent with nested structure", async () => {
    const tree = {
      root: TreeOperations.createNode({
        body: "Root",
        children: [
          TreeOperations.createNode({
            body: "Parent",
            children: [
              TreeOperations.createNode({ body: "Child" }),
            ],
          }),
        ],
      }),
    };

    const treeCell = await createMockTreeCell(tree);
    const rootCell = treeCell.key("root");
    
    console.log("Initial tree:", JSON.stringify(treeCell.get(), null, 2));
    
    // Try to outdent the child
    const result = await TreeOperations.outdentNodeCell(rootCell, [0, 0]);
    console.log("Outdent operation result:", result);

    // Check the tree after
    const updatedTree = treeCell.get();
    console.log("Tree after outdent:", JSON.stringify(updatedTree, null, 2));
    
    expect(result).toBeTruthy();
  });
});