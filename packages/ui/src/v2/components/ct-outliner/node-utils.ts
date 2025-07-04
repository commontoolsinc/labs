import type { Tree, Node } from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";

/**
 * Pure utility functions for node operations
 * 
 * @description These functions are side-effect free and work with node references.
 * They provide functional programming utilities for common node operations
 * without mutating the tree structure.
 */
export const NodeUtils = {
  /**
   * Get all nodes in depth-first order, excluding root
   */
  getAllNodesExcludingRoot(tree: Tree): Node[] {
    return TreeOperations.getAllNodes(tree.root).slice(1);
  },

  /**
   * Get visible nodes respecting collapse state
   */
  getVisibleNodes(tree: Tree, collapsedNodes: ReadonlySet<Node>): Node[] {
    // Convert ReadonlySet to Set for compatibility with TreeOperations
    const mutableCollapsedNodes = new Set(collapsedNodes);
    return TreeOperations.getAllVisibleNodes(tree.root, mutableCollapsedNodes);
  },

  /**
   * Create stable index mapping for nodes (for DOM ids)
   */
  createNodeIndexer(): {
    getIndex: (node: Node) => number;
    clear: () => void;
    size: () => number;
  } {
    let indexMap = new WeakMap<Node, number>();
    let counter = 0;

    return {
      getIndex: (node: Node) => {
        if (!indexMap.has(node)) {
          indexMap.set(node, counter++);
        }
        return indexMap.get(node)!;
      },
      clear: () => {
        indexMap = new WeakMap();
        counter = 0;
      },
      size: () => counter
    };
  },

  /**
   * Check if a node exists in the tree
   */
  nodeExistsInTree(tree: Tree, targetNode: Node): boolean {
    return TreeOperations.findNode(tree.root, targetNode) !== null;
  },

  /**
   * Get the depth of a node in the tree (root = 0)
   */
  getNodeDepth(tree: Tree, targetNode: Node): number {
    const path = TreeOperations.findNodePath(tree.root, targetNode);
    return path ? path.length - 1 : -1;
  },

  /**
   * Check if a node has children
   */
  hasChildren(node: Node): boolean {
    return node.children.length > 0;
  },

  /**
   * Check if a node is a leaf (no children)
   */
  isLeaf(node: Node): boolean {
    return node.children.length === 0;
  },

  /**
   * Get siblings of a node
   */
  getSiblings(tree: Tree, targetNode: Node): Node[] {
    const parent = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parent) return [];
    return parent.children.filter(child => child !== targetNode);
  },

  /**
   * Get node index among its siblings
   */
  getSiblingIndex(tree: Tree, targetNode: Node): number {
    const parent = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parent) return -1;
    return parent.children.indexOf(targetNode);
  },

  /**
   * Check if a node is the first child
   */
  isFirstChild(tree: Tree, targetNode: Node): boolean {
    return NodeUtils.getSiblingIndex(tree, targetNode) === 0;
  },

  /**
   * Check if a node is the last child
   */
  isLastChild(tree: Tree, targetNode: Node): boolean {
    const parent = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parent) return false;
    const index = parent.children.indexOf(targetNode);
    return index === parent.children.length - 1;
  }
};