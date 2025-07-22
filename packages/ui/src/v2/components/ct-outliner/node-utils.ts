import type { Node, Tree } from "./types.ts";
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
   * Enhanced to handle CellController operations that may recreate node objects
   * and to provide better error handling for corrupted node references
   */
  createNodeIndexer(): {
    getIndex: (node: Node) => number;
    clear: () => void;
    size: () => number;
  } {
    let indexMap = new WeakMap<Node, number>();
    let fallbackMap = new Map<string, number>();
    let counter = 0;

    // Create a stable key for a node based on its content and structure
    const createNodeKey = (node: Node): string => {
      try {
        // Ensure we can safely access node properties
        if (!node || typeof node !== 'object') {
          return `invalid:${counter++}`;
        }
        
        const body = typeof node.body === 'string' ? node.body : 'no-body';
        const childrenLength = Array.isArray(node.children) ? node.children.length : 0;
        const attachmentsLength = Array.isArray(node.attachments) ? node.attachments.length : 0;
        
        return `${body}:${childrenLength}:${attachmentsLength}`;
      } catch (error) {
        console.warn('Failed to create node key:', error);
        return `error:${counter++}`;
      }
    };

    const isValidWeakMapKey = (node: Node): boolean => {
      try {
        // Check if the node is a valid object that can be used as a WeakMap key
        if (!node || typeof node !== 'object') {
          return false;
        }
        
        // Try to access key properties to ensure the object isn't corrupted
        const _ = node.body;
        const __ = node.children;
        
        return true;
      } catch (error) {
        return false;
      }
    };

    return {
      getIndex: (node: Node) => {
        // Validate input node
        if (!node) {
          console.warn('Invalid node passed to indexer');
          return -1;
        }

        // First try WeakMap for optimal performance if node is valid
        if (isValidWeakMapKey(node)) {
          try {
            if (indexMap.has(node)) {
              return indexMap.get(node)!;
            }

            // Try to set in WeakMap
            const newIndex = counter++;
            indexMap.set(node, newIndex);
            return newIndex;
          } catch (error) {
            console.warn('WeakMap operation failed, falling back to content key:', error);
          }
        }

        // Fallback to content-based mapping for nodes that can't be WeakMap keys
        const nodeKey = createNodeKey(node);
        if (!fallbackMap.has(nodeKey)) {
          fallbackMap.set(nodeKey, counter++);
        }
        return fallbackMap.get(nodeKey)!;
      },
      clear: () => {
        indexMap = new WeakMap();
        fallbackMap = new Map();
        counter = 0;
      },
      size: () => counter,
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
    return parent.children.filter((child) => child !== targetNode);
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
  },
};
