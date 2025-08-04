import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockTreeCell } from "./test-utils.ts";
import { indentNodeSimple } from "./ct-outliner-simple.ts";
import type { Tree } from "./types.ts";

describe("Simple indent test", () => {
  it("should indent without proxy errors", async () => {
    const tree: Tree = {
      root: {
        body: "",
        children: [
          {
            body: "Item 1",
            children: [],
            attachments: [],
          },
          {
            body: "Item 2",
            children: [],
            attachments: [],
          },
        ],
        attachments: [],
      },
    };

    const treeCell = await createMockTreeCell(tree);
    
    // Indent Item 2 under Item 1
    await indentNodeSimple(treeCell, [1]);
    
    // Check the result
    const updatedTree = treeCell.get();
    expect(updatedTree.root.children.length).toBe(1);
    expect(updatedTree.root.children[0].body).toBe("Item 1");
    expect(updatedTree.root.children[0].children.length).toBe(1);
    expect(updatedTree.root.children[0].children[0].body).toBe("Item 2");
  });
});