/**
 * Temporary workaround for Cell array operations until framework bug is fixed
 * 
 * The framework currently has a bug where proxy objects extracted from one Cell
 * cannot be inserted into another Cell's array. This causes "Reflect.get called on non-object" errors.
 * 
 * This module provides workaround implementations that deep clone nodes when moving them.
 * This loses Cell reactivity but allows the operations to work.
 * 
 * TODO: Remove this file and use direct Cell operations once the framework bug is fixed
 */

import type { Cell } from "@commontools/runner";
import type { Node as OutlineTreeNode } from "./types.ts";

/**
 * Deep clones a node structure to work around the proxy limitation
 * This is necessary because we can't move proxy objects between Cell arrays
 */
function cloneNode(node: OutlineTreeNode): OutlineTreeNode {
  return {
    body: node.body,
    children: node.children.map(child => cloneNode(child)),
    attachments: [...node.attachments],
  };
}

/**
 * Moves a node from one array to another using deep cloning
 * This is a workaround for the framework bug with proxy objects
 */
export async function moveNodeBetweenArrays(
  sourceCell: Cell<OutlineTreeNode[]>,
  destCell: Cell<OutlineTreeNode[]>,
  sourceIndex: number,
  tx?: any
): Promise<void> {
  const needsCommit = !tx;
  if (!tx) {
    tx = sourceCell.runtime.edit();
  }

  // Get arrays
  const sourceArray = sourceCell.get();
  const destArray = destCell.get();

  // Clone the node to move (workaround for proxy issue)
  const nodeToMove = cloneNode(sourceArray[sourceIndex]);

  // Create new arrays
  const newSourceArray = sourceArray.filter((_, i) => i !== sourceIndex);
  const newDestArray = [...destArray, nodeToMove];

  // Update both arrays in the same transaction
  sourceCell.withTx(tx).set(newSourceArray);
  destCell.withTx(tx).set(newDestArray);

  if (needsCommit) {
    await tx.commit();
  }
}

/**
 * Inserts a node at a specific position using deep cloning
 */
export async function insertNodeAt(
  destCell: Cell<OutlineTreeNode[]>,
  node: OutlineTreeNode,
  insertIndex: number,
  tx?: any
): Promise<void> {
  const needsCommit = !tx;
  if (!tx) {
    tx = destCell.runtime.edit();
  }

  const destArray = destCell.get();
  const clonedNode = cloneNode(node);
  
  const newArray = [
    ...destArray.slice(0, insertIndex),
    clonedNode,
    ...destArray.slice(insertIndex)
  ];

  destCell.withTx(tx).set(newArray);

  if (needsCommit) {
    await tx.commit();
  }
}

/**
 * Swaps two nodes in an array
 */
export async function swapNodes(
  arrayCell: Cell<OutlineTreeNode[]>,
  index1: number,
  index2: number,
  tx?: any
): Promise<void> {
  const needsCommit = !tx;
  if (!tx) {
    tx = arrayCell.runtime.edit();
  }

  const array = arrayCell.get();
  const newArray = [...array];
  
  // Clone both nodes to avoid proxy issues
  const temp = cloneNode(array[index1]);
  newArray[index1] = cloneNode(array[index2]);
  newArray[index2] = temp;

  arrayCell.withTx(tx).set(newArray);

  if (needsCommit) {
    await tx.commit();
  }
}