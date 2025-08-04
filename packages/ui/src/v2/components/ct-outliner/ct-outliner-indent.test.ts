import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTOutliner } from "./ct-outliner.ts";
import { createMockTreeCell, waitForCellUpdate } from "./test-utils.ts";
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
        root: {
          body: "",
          children: [
            {
              body: "Item 1",
              children: [],
              attachments: [],
            },
            {
              body: "Item 2", // This will be indented under Item 1
              children: [],
              attachments: [],
            },
            {
              body: "Item 3",
              children: [],
              attachments: [],
            },
          ],
          attachments: [],
        },
      };

      const { outliner } = await setupOutliner(tree);
      
      // Indent Item 2 (index 1)
      await outliner.indentNodeByPath([1]);
      await waitForCellUpdate();

      // Verify structure
      expect(outliner.tree.root.children.length).toBe(2); // Item 1 and Item 3 at root
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[0].children.length).toBe(1);
      expect(outliner.tree.root.children[0].children[0].body).toBe("Item 2");
      expect(outliner.tree.root.children[1].body).toBe("Item 3");
    });

    it("should not indent the first child", async () => {
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

      const { outliner } = await setupOutliner(tree);
      
      // Try to indent Item 1 (index 0) - should fail
      await outliner.indentNodeByPath([0]);
      await waitForCellUpdate();

      // Verify structure is unchanged
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[1].body).toBe("Item 2");
    });
  });

  describe("outdentNodeByPath", () => {
    it("should outdent a nested node", async () => {
      const tree: Tree = {
        root: {
          body: "",
          children: [
            {
              body: "Item 1",
              children: [
                {
                  body: "Item 1.1", // This will be outdented
                  children: [],
                  attachments: [],
                },
              ],
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

      const { outliner } = await setupOutliner(tree);
      
      // Outdent Item 1.1 (path [0, 0])
      await outliner.outdentNodeByPath([0, 0]);
      await waitForCellUpdate();

      // Verify structure
      expect(outliner.tree.root.children.length).toBe(3); // Item 1, Item 1.1, Item 2
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[0].children.length).toBe(0);
      expect(outliner.tree.root.children[1].body).toBe("Item 1.1");
      expect(outliner.tree.root.children[2].body).toBe("Item 2");
    });

    it("should not outdent root-level nodes", async () => {
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

      const { outliner } = await setupOutliner(tree);
      
      // Try to outdent Item 1 (path [0]) - should fail
      await outliner.outdentNodeByPath([0]);
      await waitForCellUpdate();

      // Verify structure is unchanged
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[1].body).toBe("Item 2");
    });
  });

  describe("combined operations", () => {
    it("should handle indent then outdent", async () => {
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

      const { outliner } = await setupOutliner(tree);
      
      // Indent Item 2
      await outliner.indentNodeByPath([1]);
      await waitForCellUpdate();

      // Verify indented
      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0].children.length).toBe(1);
      expect(outliner.tree.root.children[0].children[0].body).toBe("Item 2");

      // Outdent Item 2 (now at path [0, 0])
      await outliner.outdentNodeByPath([0, 0]);
      await waitForCellUpdate();

      // Verify back to original structure
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[0].body).toBe("Item 1");
      expect(outliner.tree.root.children[1].body).toBe("Item 2");
    });
  });
});