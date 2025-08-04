import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockTreeCell, waitForCellUpdate } from "./test-utils.ts";
import { type Cell } from "@commontools/runner";

/**
 * Test suite to understand Cell array operations
 * These tests explore how to properly work with arrays in Cells
 * without using .get() to extract values
 */
describe("Cell Array Operations", () => {
  describe("Basic array operations", () => {
    it("should update an item at a specific index", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            { body: "Item 1", children: [], attachments: [] },
            { body: "Item 2", children: [], attachments: [] },
            { body: "Item 3", children: [], attachments: [] },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: Update "Item 2" to "Updated Item 2" without using .get()
      // Question: How do we update a specific item in an array?

      // Attempt 1: Using key() to navigate?
      const itemCell = treeCell.key("root").key("children").key(1).key("body");
      const tx = treeCell.runtime.edit();
      itemCell.withTx(tx).set("Updated Item 2");

      // Verify the update
      const updated = treeCell.get();
      expect(updated.root.children[1].body).toBe("Updated Item 2");
    });

    it("should insert an item at a specific index", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            { body: "Item 1", children: [], attachments: [] },
            { body: "Item 3", children: [], attachments: [] },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);
      const newItem = { body: "Item 2", children: [], attachments: [] };

      // TODO: Insert newItem at index 1 without using .get()
      // Question: How do we insert into an array without extracting it first?

      const children = treeCell.key("root").key("children");
      let tx = treeCell.runtime.edit();
      const values = children.withTx(tx).get();
      values.splice(1, 0, newItem);
      tx = treeCell.runtime.edit();
      children.withTx(tx).set(values);

      // Verify the insertion
      const updated = treeCell.get();
      expect(updated.root.children.length).toBe(3);
      expect(updated.root.children[1].body).toBe("Item 2");
    });

    it("should remove an item at a specific index", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            { body: "Item 1", children: [], attachments: [] },
            { body: "Item 2", children: [], attachments: [] },
            { body: "Item 3", children: [], attachments: [] },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: Remove item at index 1 without using .get()
      // Question: How do we remove from an array without extracting it first?

      const children = treeCell.key("root").key("children");
      let tx = treeCell.runtime.edit();
      const values = children.withTx(tx).get();
      values.splice(1, 1);
      tx = treeCell.runtime.edit();
      children.withTx(tx).set(values);

      // Verify the removal
      const updated = treeCell.get();
      expect(updated.root.children.length).toBe(2);
      expect(updated.root.children[0].body).toBe("Item 1");
      expect(updated.root.children[1].body).toBe("Item 3");
    });
  });

  describe("Moving items between arrays", () => {
    it("should move an item from one array to another at same level", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            {
              body: "Parent 1",
              children: [
                { body: "Child 1.1", children: [], attachments: [] },
                { body: "Child 1.2", children: [], attachments: [] },
              ],
              attachments: []
            },
            {
              body: "Parent 2",
              children: [],
              attachments: []
            },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: Move "Child 1.2" from Parent 1 to Parent 2
      // This is the core operation needed for indent/outdent
      // Question: How do we move without extracting the value?

      const source = treeCell.key("root").key("children").key(0).key('children');
      const dest = treeCell.key("root").key("children").key(1).key('children');

      // let tx = treeCell.runtime.edit();
      const values = source.get();
      const item = values[1];
      // values.splice(1, 1);
      let tx = treeCell.runtime.edit();
      source.withTx(tx).set(values.filter((value) => value !== item));

      // tx = treeCell.runtime.edit();
      const destValues = dest.get();
      //destValues.push(item);
      tx = treeCell.runtime.edit();
      dest.withTx(tx).set([...destValues, item]);

      // Verify the move
      const updated = treeCell.get();
      expect(updated.root.children[0].children.length).toBe(1);
      expect(updated.root.children[0].children[0].body).toBe("Child 1.1");
      expect(updated.root.children[1].children.length).toBe(1);
      expect(updated.root.children[1].children[0].body).toBe("Child 1.2");
    });

    it("should move an item between different hierarchy levels", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            {
              body: "Parent",
              children: [
                {
                  body: "Child",
                  children: [
                    { body: "Grandchild", children: [], attachments: [] }
                  ],
                  attachments: []
                },
              ],
              attachments: []
            },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: Move "Grandchild" up to be a sibling of "Child"
      // This simulates outdenting in the outliner

      // Verify the move
      const updated = treeCell.get();
      expect(updated.root.children[0].children.length).toBe(2);
      expect(updated.root.children[0].children[0].body).toBe("Child");
      expect(updated.root.children[0].children[0].children.length).toBe(0);
      expect(updated.root.children[0].children[1].body).toBe("Grandchild");
    });
  });

  describe("Complex operations", () => {
    it("should swap two items in an array", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            { body: "Item 1", children: [], attachments: [] },
            { body: "Item 2", children: [], attachments: [] },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: Swap Item 1 and Item 2 positions
      // Question: Can we do this atomically or do we need multiple operations?

      // Verify the swap
      const updated = treeCell.get();
      expect(updated.root.children[0].body).toBe("Item 2");
      expect(updated.root.children[1].body).toBe("Item 1");
    });

    it("should maintain references when moving items", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            {
              body: "Parent 1",
              children: [
                {
                  body: "Special Child",
                  children: [
                    { body: "Nested 1", children: [], attachments: [] },
                    { body: "Nested 2", children: [], attachments: [] },
                  ],
                  attachments: []
                },
              ],
              attachments: []
            },
            { body: "Parent 2", children: [], attachments: [] },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: Move "Special Child" with all its children to Parent 2
      // Question: Do the nested children maintain their structure?

      // Verify the move preserved nested structure
      const updated = treeCell.get();
      expect(updated.root.children[0].children.length).toBe(0);
      expect(updated.root.children[1].children.length).toBe(1);
      expect(updated.root.children[1].children[0].body).toBe("Special Child");
      expect(updated.root.children[1].children[0].children.length).toBe(2);
      expect(updated.root.children[1].children[0].children[0].body).toBe("Nested 1");
    });
  });

  describe("Cell reference operations", () => {
    it("should work with Cell references instead of values", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            { body: "Item 1", children: [], attachments: [] },
            { body: "Item 2", children: [], attachments: [] },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: Test if we can pass Cell references to .set()
      // As the user mentioned: "you can pass a Cell to .set()"

      // What does this mean exactly?
      // const item1Cell = treeCell.key("root").key("children").key(0);
      // const childrenCell = treeCell.key("root").key("children");
      // childrenCell.set([item1Cell]); // Is this what they mean?
    });

    it("should handle array operations without .get()", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            { body: "A", children: [], attachments: [] },
            { body: "B", children: [], attachments: [] },
            { body: "C", children: [], attachments: [] },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: Implement array operations without ever calling .get()
      // This is the key constraint from the user: "NEVER CALL .get()"

      // Operations to test:
      // 1. Reorder items (move C before A)
      // 2. Filter items (remove B)
      // 3. Transform items (uppercase all bodies)

      // All without using .get() to extract the array
    });
  });

  describe("Transaction behavior", () => {
    it("should perform multiple operations in a single transaction", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            {
              body: "Parent 1",
              children: [
                { body: "Child 1", children: [], attachments: [] },
              ],
              attachments: []
            },
            {
              body: "Parent 2",
              children: [
                { body: "Child 2", children: [], attachments: [] },
              ],
              attachments: []
            },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // TODO: In one transaction:
      // 1. Move Child 1 to Parent 2
      // 2. Move Child 2 to Parent 1
      // 3. Rename Parent 1 to "Updated Parent 1"

      // Question: How do we coordinate multiple Cell operations?

      // Verify all operations completed
      const updated = treeCell.get();
      expect(updated.root.children[0].body).toBe("Updated Parent 1");
      expect(updated.root.children[0].children[0].body).toBe("Child 2");
      expect(updated.root.children[1].children[0].body).toBe("Child 1");
    });
  });
});
