import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTOutliner } from "./ct-outliner.ts";
import {
  createMockTreeCell,
  waitForCellUpdate,
  waitForOutlinerUpdate,
} from "./test-utils.ts";
import { TreeOperations } from "./tree-operations.ts";
import type { Tree } from "./types.ts";

describe("CTOutliner Indentation Operations (CT-693)", () => {
  async function setupOutliner(tree: Tree) {
    const outliner = new CTOutliner();
    const treeCell = await createMockTreeCell(tree);
    outliner.value = treeCell;
    return { outliner, treeCell };
  }

  describe("indentNodeByPath", () => {
    it("should indent a node under its previous sibling", async () => {
      const tree: Tree = {
        root: TreeOperations.createNode({
          body: "",
          children: [
            TreeOperations.createNode({ body: "Item 1" }),
            TreeOperations.createNode({ body: "Item 2" }), // This will be indented under Item 1
            TreeOperations.createNode({ body: "Item 3" }),
          ],
        }),
      };

      const { outliner } = await setupOutliner(tree);

      // Indent Item 2 (index 1)
      const result = await outliner.indentNodeByPath([1]);
      await waitForOutlinerUpdate(outliner);

      // Check that the operation succeeded
      expect(result.success).toBe(true);

      // Verify structure
      expect(outliner.tree.root.children.length).toBe(2); // Item 1 and Item 3 at root
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[0].children.length).toBe(1);
      expect(outliner.tree.root.children[0].children[0].body).toBe("Item 2");
      expect(outliner.tree.root.children[1].body).toBe("Item 3");
    });

    it("should not indent the first child", async () => {
      const tree: Tree = {
        root: TreeOperations.createNode({
          body: "",
          children: [
            TreeOperations.createNode({ body: "Item 1" }),
            TreeOperations.createNode({ body: "Item 2" }),
          ],
        }),
      };

      const { outliner } = await setupOutliner(tree);

      // Try to indent Item 1 (index 0) - should fail
      const result = await outliner.indentNodeByPath([0]);
      await waitForCellUpdate();

      // Check that the operation failed
      expect(result.success).toBe(false);

      // Verify structure is unchanged
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[1].body).toBe("Item 2");
    });
  });

  describe("outdentNodeByPath", () => {
    it("should outdent a nested node", async () => {
      const tree: Tree = {
        root: TreeOperations.createNode({
          body: "",
          children: [
            TreeOperations.createNode({
              body: "Item 1",
              children: [
                TreeOperations.createNode({ body: "Item 1.1" }), // This will be outdented
              ],
            }),
            TreeOperations.createNode({ body: "Item 2" }),
          ],
        }),
      };

      const { outliner } = await setupOutliner(tree);

      // Outdent Item 1.1 (path [0, 0])
      const result = await outliner.outdentNodeByPath([0, 0]);
      await waitForCellUpdate();

      // Check that the operation succeeded
      expect(result.success).toBe(true);

      // Verify structure
      expect(outliner.tree.root.children.length).toBe(3); // Item 1, Item 1.1, Item 2
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[0].children.length).toBe(0);
      expect(outliner.tree.root.children[1].body).toBe("Item 1.1");
      expect(outliner.tree.root.children[2].body).toBe("Item 2");
    });

    it("should not outdent root-level nodes", async () => {
      const tree: Tree = {
        root: TreeOperations.createNode({
          body: "",
          children: [
            TreeOperations.createNode({ body: "Item 1" }),
            TreeOperations.createNode({ body: "Item 2" }),
          ],
        }),
      };

      const { outliner } = await setupOutliner(tree);

      // Try to outdent Item 1 (path [0]) - should fail
      const result = await outliner.outdentNodeByPath([0]);
      await waitForCellUpdate();

      // Check that the operation failed
      expect(result.success).toBe(false);

      // Verify structure is unchanged
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[1].body).toBe("Item 2");
    });
  });

  describe("combined operations", () => {
    it("should handle indent then outdent", async () => {
      const tree: Tree = {
        root: TreeOperations.createNode({
          body: "",
          children: [
            TreeOperations.createNode({ body: "Item 1" }),
            TreeOperations.createNode({ body: "Item 2" }),
          ],
        }),
      };

      const { outliner } = await setupOutliner(tree);

      // Indent Item 2
      const indentResult = await outliner.indentNodeByPath([1]);
      await waitForCellUpdate();

      // Check that the indent operation succeeded
      expect(indentResult.success).toBe(true);

      // Verify indented
      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0].children.length).toBe(1);
      expect(outliner.tree.root.children[0].children[0].body).toBe("Item 2");

      // Outdent Item 2 (now at path [0, 0])
      const outdentResult = await outliner.outdentNodeByPath([0, 0]);
      await waitForCellUpdate();

      // Check that the outdent operation succeeded
      expect(outdentResult.success).toBe(true);

      // Verify back to original structure
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[1].body).toBe("Item 2");
    });
  });
});
