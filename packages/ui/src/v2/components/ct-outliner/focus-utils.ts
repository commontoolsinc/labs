import type { Node, Tree } from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";
import { NodeUtils } from "./node-utils.ts";

/**
 * Pure utility functions for focus management
 * These functions determine focus without causing side effects
 */
export const FocusUtils = {
  /**
   * Determine next focus after node deletion
   */
  getNextFocusAfterDeletion(
    tree: Tree,
    parentNode: Node,
    deletedIndex: number,
  ): Node | null {
    const siblings = parentNode.children;

    // Try previous sibling first
    if (deletedIndex > 0 && siblings[deletedIndex - 1]) {
      return siblings[deletedIndex - 1];
    }

    // Try next sibling
    if (deletedIndex < siblings.length && siblings[deletedIndex]) {
      return siblings[deletedIndex];
    }

    // Fall back to first visible node
    const allNodes = NodeUtils.getVisibleNodes(tree, new Set());
    return allNodes.length > 0 ? allNodes[0] : null;
  },

  /**
   * Find valid focus node in tree, with fallback logic
   */
  findValidFocus(tree: Tree, preferredNode: Node | null): Node | null {
    // If preferred node exists in tree, use it
    if (preferredNode && NodeUtils.nodeExistsInTree(tree, preferredNode)) {
      return preferredNode;
    }

    // Fall back to first child of root
    if (tree.root.children.length > 0) {
      return tree.root.children[0];
    }

    // No nodes available
    return null;
  },

  /**
   * Get next focusable node in navigation order
   */
  getNextFocusableNode(
    tree: Tree,
    currentNode: Node,
    collapsedNodes: ReadonlySet<Node>,
    direction: "up" | "down",
  ): Node | null {
    const visibleNodes = NodeUtils.getVisibleNodes(tree, collapsedNodes);
    const currentIndex = visibleNodes.indexOf(currentNode);

    if (currentIndex === -1) return null;

    if (direction === "up") {
      return currentIndex > 0 ? visibleNodes[currentIndex - 1] : null;
    } else {
      return currentIndex < visibleNodes.length - 1
        ? visibleNodes[currentIndex + 1]
        : null;
    }
  },

  /**
   * Find parent node that can receive focus
   */
  getFocusableParent(tree: Tree, node: Node): Node | null {
    const parent = TreeOperations.findParentNode(tree.root, node);

    // Don't focus root node
    if (!parent || parent === tree.root) {
      return null;
    }

    return parent;
  },

  /**
   * Get first focusable child of a node
   */
  getFirstFocusableChild(node: Node): Node | null {
    return node.children.length > 0 ? node.children[0] : null;
  },

  /**
   * Get last focusable descendant of a node (for navigation)
   */
  getLastFocusableDescendant(
    node: Node,
    collapsedNodes: ReadonlySet<Node>,
  ): Node {
    // If node is collapsed or has no children, return the node itself
    if (collapsedNodes.has(node) || node.children.length === 0) {
      return node;
    }

    // Recursively find the last descendant
    const lastChild = node.children[node.children.length - 1];
    return FocusUtils.getLastFocusableDescendant(lastChild, collapsedNodes);
  },

  /**
   * Check if focus change is allowed based on editing state
   */
  canChangeFocus(isEditing: boolean, hasUnsavedChanges: boolean): boolean {
    // Always allow focus change if not editing
    if (!isEditing) return true;

    // During editing, only allow if no unsaved changes
    return !hasUnsavedChanges;
  },

  /**
   * Calculate focus after tree structure change
   */
  calculateFocusAfterTreeChange(
    tree: Tree,
    previousFocus: Node | null,
    operation: "insert" | "delete" | "move" | "indent" | "outdent",
    affectedNode: Node,
  ): Node | null {
    switch (operation) {
      case "insert":
        // Focus the newly inserted node
        return affectedNode;

      case "delete":
        // Don't use affected node (it's deleted), use previous focus logic
        return FocusUtils.findValidFocus(tree, previousFocus);

      case "move":
      case "indent":
      case "outdent":
        // Keep focus on the moved node
        return affectedNode;

      default:
        return FocusUtils.findValidFocus(tree, previousFocus);
    }
  },
};
