import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockTreeCell, waitForCellUpdate } from "./test-utils.ts";
import { type Cell, ID } from "@commontools/runner";

/**
 * Test suite to understand Cell array operations
 * These tests explore how to properly work with arrays in Cells
 * without using .get() to extract values
 *
 * IMPORTANT: These tests currently fail due to a framework bug
 * where moving proxy objects between arrays causes Reflect.get errors
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

      // Update a specific item in array using key navigation
      const tx = treeCell.runtime.edit();
      const itemCell = treeCell.key("root").key("children").key(1).key("body");
      itemCell.withTx(tx).set("Updated Item 2");
      await tx.commit();

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

      // Insert by getting array, modifying, and setting back
      const tx = treeCell.runtime.edit();
      const childrenCell = treeCell.key("root").key("children");
      const children = childrenCell.get();
      const newChildren = [
        children[0],
        newItem,
        children[1]
      ];
      childrenCell.withTx(tx).set(newChildren);
      await tx.commit();

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

      // Remove by filtering
      const children = treeCell.key("root").key("children");
      let tx = treeCell.runtime.edit();
      const values = children.withTx(tx).get();
      values.splice(1, 1);
      await tx.commit();

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

      // Move "Child 1.2" from Parent 1 to Parent 2
      const source = treeCell.key("root").key("children").key(0).key("children");
      const dest = treeCell.key("root").key("children").key(1).key("children");

      // Get the item to move
      let sourceValues = source.get();
      const itemToMove = sourceValues[1];
      // (itemToMove as any)[ID] = crypto.randomUUID()


      // Add to destination
      let tx = treeCell.runtime.edit();
      const destValues = dest.get();
      dest.withTx(tx).set([...destValues, itemToMove]);
      // await tx.commit();
      // Remove from source
      source.withTx(tx).set(sourceValues.filter(value => value !== itemToMove));
      await tx.commit();

      // Add to destination
      // let tx = treeCell.runtime.edit();
      // const destValues = dest.withTx(tx).get();

      // destValues.push(itemToMove);
      // await tx.commit();
      // tx = treeCell.runtime.edit();
      // sourceValues = source.withTx(tx).get();
      // // Remove from source
      // source.withTx(tx).get().splice(1, 1);
      // await tx.commit();


      // Verify the move
      const updated = treeCell.get();
      console.dir(updated, { depth: null })
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

      // Move "Grandchild" up to be a sibling of "Child"
      const source = treeCell.key("root").key("children").key(0).key("children").key(0).key("children");
      const dest = treeCell.key("root").key("children").key(0).key("children");

      // Get the item to move
      const sourceValues = source.get();
      const itemToMove = sourceValues[0];

      // Remove from source
      let tx = treeCell.runtime.edit();
      source.withTx(tx).set([]);
      await tx.commit();

      // Add to destination
      tx = treeCell.runtime.edit();
      const destValues = dest.get();
      dest.withTx(tx).set([...destValues, itemToMove]);
      await tx.commit();

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

      // Swap by creating new array with swapped positions
      const tx = treeCell.runtime.edit();
      const childrenCell = treeCell.key("root").key("children");
      const children = childrenCell.get();
      const newChildren = [children[1], children[0]];
      childrenCell.withTx(tx).set(newChildren);
      await tx.commit();

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

      // Move "Special Child" with all its children to Parent 2
      const source = treeCell.key("root").key("children").key(0).key("children");
      const dest = treeCell.key("root").key("children").key(1).key("children");

      // Get the complex item to move
      const sourceValues = source.get();
      const itemToMove = sourceValues[0];

      // Remove from source
      let tx = treeCell.runtime.edit();
      source.withTx(tx).set([]);
      await tx.commit();

      // Add to destination
      tx = treeCell.runtime.edit();
      const destValues = dest.get();
      dest.withTx(tx).set([itemToMove]);
      await tx.commit();

      // Verify the move preserved nested structure
      const updated = treeCell.get();
      expect(updated.root.children[0].children.length).toBe(0);
      expect(updated.root.children[1].children.length).toBe(1);
      expect(updated.root.children[1].children[0].body).toBe("Special Child");
      expect(updated.root.children[1].children[0].children.length).toBe(2);
      expect(updated.root.children[1].children[0].children[0].body).toBe("Nested 1");
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

      // Perform all operations in one transaction
      const tx = treeCell.runtime.edit();

      // Get all the cells and values we need
      const parent1NameCell = treeCell.key("root").key("children").key(0).key("body");
      const parent1ChildrenCell = treeCell.key("root").key("children").key(0).key("children");
      const parent2ChildrenCell = treeCell.key("root").key("children").key(1).key("children");

      const parent1Children = parent1ChildrenCell.get();
      const parent2Children = parent2ChildrenCell.get();
      const child1 = parent1Children[0];
      const child2 = parent2Children[0];

      // 1. Rename Parent 1
      parent1NameCell.withTx(tx).set("Updated Parent 1");

      // 2. Move Child 1 to Parent 2 and Child 2 to Parent 1
      parent1ChildrenCell.withTx(tx).set([child2]);
      parent2ChildrenCell.withTx(tx).set([child1]);

      await tx.commit();

      // Verify all operations completed
      const updated = treeCell.get();
      expect(updated.root.children[0].body).toBe("Updated Parent 1");
      expect(updated.root.children[0].children[0].body).toBe("Child 2");
      expect(updated.root.children[1].children[0].body).toBe("Child 1");
    });
  });

  describe("Framework bug demonstration", () => {
    it("should handle proxy objects when moving between arrays (currently fails)", async () => {
      const tree = {
        root: {
          body: "",
          children: [
            {
              body: "Source",
              children: [
                { body: "Item to move", children: [], attachments: [] },
              ],
              attachments: []
            },
            {
              body: "Destination",
              children: [],
              attachments: []
            },
          ],
          attachments: [],
        },
      };

      const treeCell = await createMockTreeCell(tree);

      // This pattern should work but currently throws Reflect.get error
      const source = treeCell.key("root").key("children").key(0).key("children");
      const dest = treeCell.key("root").key("children").key(1).key("children");

      const values = source.get();
      const item = values[0];

      // These operations fail with Reflect.get error
      let tx = treeCell.runtime.edit();
      source.withTx(tx).set([]);
      await tx.commit();

      tx = treeCell.runtime.edit();
      dest.withTx(tx).set([item]); // This line causes the error
      await tx.commit();

      // Expected result (if bug was fixed)
      const updated = treeCell.get();
      expect(updated.root.children[0].children.length).toBe(0);
      expect(updated.root.children[1].children.length).toBe(1);
      expect(updated.root.children[1].children[0].body).toBe("Item to move");
    });
  });
});
