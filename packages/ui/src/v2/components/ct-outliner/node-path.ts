import { type Cell } from "@commontools/runner";
import type { Node as OutlineTreeNode, Tree } from "./types.ts";

/**
 * Node path utilities for navigating and managing tree structures
 * These functions provide path-based operations that are more reliable
 * than reference-based operations when working with Cell updates.
 */

/**
 * Convert a path to a string for use as a key
 */
export function pathToString(path: number[]): string {
  return path.join(".");
}

/**
 * Convert a string key back to a path
 */
export function stringToPath(str: string): number[] {
  return str ? str.split(".").map(Number) : [];
}

/**
 * Get the node at a given path
 */
export function getNodeByPath(tree: Tree, path: number[]): OutlineTreeNode | null {
  if (path.length === 0) {
    return tree.root;
  }

  let current = tree.root;
  for (const index of path) {
    if (!current.children || index >= current.children.length) {
      return null;
    }
    current = current.children[index];
  }
  return current;
}

/**
 * Get the path to a node as an array of indices from root.children
 */
export function getNodePath(tree: Tree, targetNode: OutlineTreeNode | Cell<OutlineTreeNode>): number[] | null {
  // If it's a Cell, we need to find it in the tree
  if ('equals' in targetNode) {
    if (!tree) return null;

    const findCellPath = (
      currentCell: Cell<OutlineTreeNode>,
      currentPath: number[],
    ): number[] | null => {
      if (currentCell.equals(targetNode)) {
        return currentPath;
      }

      const children = currentCell.key("children").getAsQueryResult();
      for (let i = 0; i < children.length; i++) {
        const childCell = currentCell.key("children").key(i);
        const result = findCellPath(childCell, [...currentPath, i]);
        if (result) return result;
      }

      return null;
    };

    // For Cell-based finding, we need access to the tree Cell
    // This function signature may need to be adjusted based on usage
    return null; // Placeholder - will need tree Cell access
  }

  // Original logic for regular nodes
  const targetNodeTyped = targetNode as OutlineTreeNode;
  // Handle root node as a special case
  if (targetNodeTyped === tree.root) {
    return []; // Root node has empty path
  }

  const findPath = (
    node: OutlineTreeNode,
    currentPath: number[],
  ): number[] | null => {
    if (!node || !node.children) {
      return null;
    }

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (!child) continue;

      const childPath = [...currentPath, i];

      if (child === targetNodeTyped) {
        return childPath;
      }

      const result = findPath(child, childPath);
      if (result) {
        return result;
      }
    }
    return null;
  };

  return findPath(tree.root, []);
}

/**
 * Get the Cell for a specific node in the tree using its path
 * @param treeCell The root Cell<Tree> containing the tree data
 * @param node The target node to get a Cell for
 * @returns Cell<Node> pointing to the node, or null if not found
 */
export function getNodeCell(treeCell: Cell<Tree>, tree: Tree, node: OutlineTreeNode): Cell<OutlineTreeNode> | null {
  const nodePath = getNodePath(tree, node);
  if (nodePath === null) return null;

  // Handle root node (empty path)
  if (nodePath.length === 0) {
    return treeCell.key("root") as Cell<OutlineTreeNode>;
  }

  let targetCell: Cell<any> = treeCell.key("root").key("children");
  for (let i = 0; i < nodePath.length; i++) {
    targetCell = targetCell.key(nodePath[i]);
    if (i < nodePath.length - 1) {
      targetCell = targetCell.key("children");
    }
  }

  return targetCell as Cell<OutlineTreeNode>;
}

/**
 * Get the Cell for a specific node's body content
 * @param treeCell The root Cell<Tree> containing the tree data
 * @param tree The tree structure for path finding
 * @param node The target node to get a body Cell for
 * @returns Cell<string> pointing to the node's body, or null if not found
 */
export function getNodeBodyCell(treeCell: Cell<Tree>, tree: Tree, node: OutlineTreeNode): Cell<string> | null {
  const nodeCell = getNodeCell(treeCell, tree, node);
  return nodeCell ? nodeCell.key("body") as Cell<string> : null;
}

/**
 * Get the Cell for a node's body content using a path
 * @param treeCell The root Cell<Tree> containing the tree data
 * @param nodePath The path to the node as an array of indices
 * @returns Cell<string> pointing to the node's body, or null if not found
 */
export function getNodeBodyCellByPath(treeCell: Cell<Tree>, nodePath: number[]): Cell<string> | null {
  // Handle root node (empty path)
  if (nodePath.length === 0) {
    return treeCell.key("root").key("body") as Cell<string>;
  }

  let targetCell: Cell<any> = treeCell.key("root").key("children");
  for (let i = 0; i < nodePath.length; i++) {
    targetCell = targetCell.key(nodePath[i]);
    if (i < nodePath.length - 1) {
      targetCell = targetCell.key("children");
    }
  }

  return targetCell.key("body") as Cell<string>;
}

/**
 * Get the Cell for a specific node's children array
 * @param treeCell The root Cell<Tree> containing the tree data (optional, used when node is regular Node)
 * @param tree The tree structure for path finding (optional, used when node is regular Node)
 * @param node The target node to get a children Cell for
 * @returns Cell<OutlineTreeNode[]> pointing to the node's children, or null if not found
 */
export function getNodeChildrenCell(
  treeCell: Cell<Tree> | null,
  tree: Tree | null,
  node: OutlineTreeNode | Cell<OutlineTreeNode>,
): Cell<OutlineTreeNode[]> | null {
  if ('equals' in node) {
    // It's already a Cell
    return node.key("children") as Cell<OutlineTreeNode[]>;
  } else {
    // It's a regular node - need tree context
    if (!treeCell || !tree) return null;
    const nodeCell = getNodeCell(treeCell, tree, node);
    return nodeCell
      ? nodeCell.key("children") as Cell<OutlineTreeNode[]>
      : null;
  }
}

/**
 * Get a Cell at a specific path, supporting both numeric indices and string keys
 */
export function getNodeCellByPath(treeCell: Cell<Tree>, path: (number | string)[]): Cell<any> | null {
  let cell: Cell<any> = treeCell.key("root");

  for (const segment of path) {
    if (segment === "children" || typeof segment === "string") {
      cell = cell.key(segment);
    } else {
      cell = cell.key("children").key(segment);
    }
  }

  return cell;
}