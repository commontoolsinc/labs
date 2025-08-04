// Simplified indent/outdent for testing
import type { Cell } from "@commontools/runner";

export function indentNodeSimple(
  treeCell: Cell<any>,
  nodePath: number[],
) {
  if (nodePath.length === 0 || nodePath[nodePath.length - 1] === 0) {
    throw new Error("Cannot indent first child or root");
  }

  const tx = treeCell.runtime.edit();
  
  // Get the tree
  const tree = treeCell.get();
  
  // Navigate to parent's children
  let parent = tree.root;
  for (let i = 0; i < nodePath.length - 1; i++) {
    parent = parent.children[nodePath[i]];
  }
  
  const nodeIndex = nodePath[nodePath.length - 1];
  const node = parent.children[nodeIndex];
  const previousSibling = parent.children[nodeIndex - 1];
  
  // Create new structure
  const newTree = JSON.parse(JSON.stringify(tree)); // Deep clone
  
  // Navigate to the location in the new tree
  let newParent = newTree.root;
  for (let i = 0; i < nodePath.length - 1; i++) {
    newParent = newParent.children[nodePath[i]];
  }
  
  // Remove from parent
  const removedNode = newParent.children.splice(nodeIndex, 1)[0];
  
  // Add to previous sibling
  newParent.children[nodeIndex - 1].children.push(removedNode);
  
  // Set the new tree
  treeCell.withTx(tx).set(newTree);
  return tx.commit();
}