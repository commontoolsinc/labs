import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Cell, Runtime } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

/**
 * Standalone test suite demonstrating Cell array operation issues
 *
 * This test file can be run independently to reproduce the framework bug
 * where moving objects between Cell arrays causes Reflect.get errors.
 */

// Simple tree-like structure for testing
interface TreeNode {
  name: string;
  children: TreeNode[];
}

interface Tree {
  root: TreeNode;
}

// Helper to create a real Cell
async function createCell<T>(initialValue: T): Promise<Cell<T>> {
  const signer = await Identity.fromPassphrase("test-user");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });

  const runtime = new Runtime({
    storageManager,
    blobbyServerUrl: import.meta.url,
  });

  const tx = runtime.edit();
  const cell = runtime.getCell<T>(space as any, "test-cell", undefined, tx);
  cell.set(initialValue);
  await tx.commit();
  return cell;
}

describe("Cell Array Operations - Standalone", () => {
  it("should update a nested property", async () => {
    const tree: Tree = {
      root: {
        name: "Root",
        children: [
          { name: "Child 1", children: [] },
          { name: "Child 2", children: [] },
        ],
      },
    };

    const treeCell = await createCell(tree);

    // Update a nested property - this works fine
    const tx = treeCell.runtime.edit();
    const childNameCell = treeCell.key("root").key("children").key(1).key("name");
    childNameCell.withTx(tx).set("Updated Child 2");
    await tx.commit();

    const updated = treeCell.get();
    expect(updated.root.children[1].name).toBe("Updated Child 2");
  });

  it("should demonstrate the array move bug", async () => {
    const tree: Tree = {
      root: {
        name: "Root",
        children: [
          {
            name: "Parent 1",
            children: [
              { name: "Child A", children: [] },
              { name: "Child B", children: [] },
            ],
          },
          {
            name: "Parent 2",
            children: [],
          },
        ],
      },
    };

    const treeCell = await createCell(tree);

    // Try to move "Child B" from Parent 1 to Parent 2
    const source = treeCell.key("root").key("children").key(0).key("children");
    const dest = treeCell.key("root").key("children").key(1).key("children");

    // Get the item to move
    const sourceValues = source.get();
    const itemToMove = sourceValues[1]; // Child B

    // Remove from source (this works)
    let tx = treeCell.runtime.edit();
    source.withTx(tx).set([sourceValues[0]]); // Keep only Child A
    await tx.commit();

    // Try to add to destination (this fails with Reflect.get error)
    tx = treeCell.runtime.edit();
    const destValues = dest.get();

    // This line throws: "Reflect.get called on non-object"
    // because itemToMove is a proxy from a different Cell context
    dest.withTx(tx).set([...destValues, itemToMove]);
    await tx.commit();

    // If it worked, we'd expect:
    const updated = treeCell.get();
    expect(updated.root.children[0].children.length).toBe(1);
    expect(updated.root.children[0].children[0].name).toBe("Child A");
    expect(updated.root.children[1].children.length).toBe(1);
    expect(updated.root.children[1].children[0].name).toBe("Child B");
  });

  it("shows that even simple array operations fail", async () => {
    const data = {
      list1: [{ id: "A" }, { id: "B" }, { id: "C" }],
      list2: [{ id: "X" }, { id: "Y" }, { id: "Z" }],
    };

    const cell = await createCell(data);

    // Try to move "B" from list1 to list2
    const list1 = cell.key("list1");
    const list2 = cell.key("list2");

    const values1 = list1.get();
    const itemToMove = values1[1]; // { id: "B" }

    // Remove from list1
    let tx = cell.runtime.edit();
    list1.withTx(tx).set([{ id: "A" }, { id: "C" }]);
    await tx.commit();

    // Try to add to list2 - this fails
    tx = cell.runtime.edit();
    const values2 = list2.get();
    list2.withTx(tx).set([...values2, itemToMove]); // Reflect.get error here
    await tx.commit();

    const updated = cell.get();
    expect(updated.list1).toEqual([{ id: "A" }, { id: "C" }]);
    expect(updated.list2).toEqual([{ id: "X" }, { id: "Y" }, { id: "Z" }, { id: "B" }]);
  });

  it("shows the workaround using deep cloning", async () => {
    const tree: Tree = {
      root: {
        name: "Root",
        children: [
          {
            name: "Parent 1",
            children: [
              { name: "Child A", children: [] },
              { name: "Child B", children: [] },
            ],
          },
          {
            name: "Parent 2",
            children: [],
          },
        ],
      },
    };

    const treeCell = await createCell(tree);

    // Move "Child B" using deep clone workaround
    const source = treeCell.key("root").key("children").key(0).key("children");
    const dest = treeCell.key("root").key("children").key(1).key("children");

    const sourceValues = source.get();
    const itemToMove = sourceValues[1];

    // Deep clone to break proxy connection
    const clonedItem = JSON.parse(JSON.stringify(itemToMove));

    // Now both operations work
    let tx = treeCell.runtime.edit();
    source.withTx(tx).set([sourceValues[0]]);
    await tx.commit();

    tx = treeCell.runtime.edit();
    const destValues = dest.get();
    dest.withTx(tx).set([...destValues, clonedItem]);
    await tx.commit();

    const updated = treeCell.get();
    expect(updated.root.children[0].children.length).toBe(1);
    expect(updated.root.children[0].children[0].name).toBe("Child A");
    expect(updated.root.children[1].children.length).toBe(1);
    expect(updated.root.children[1].children[0].name).toBe("Child B");
  });
});
