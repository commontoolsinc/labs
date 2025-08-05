/**
 * Tree diff types and utilities for path-based operations
 */

/**
 * Represents a change to a specific path in the tree
 */
export interface PathChange {
  /** The type of change */
  type: "create" | "delete" | "move" | "update" | "focus";
  /** The path affected by this change */
  path: number[];
  /** For move operations, the new path */
  newPath?: number[];
  /** For update operations, the new value */
  value?: any;
  /** For create operations, the node data */
  nodeData?: {
    body: string;
    children?: any[];
    attachments?: any[];
  };
}

/**
 * Result of a tree operation containing diffs and new focus state
 */
export interface TreeOperationResult {
  /** List of changes that occurred */
  changes: PathChange[];
  /** New focused path after the operation */
  newFocusedPath: number[] | null;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Calculator for tree diffs - generates PathChange objects for various operations
 */
export class TreeDiffCalculator {
  /**
   * Calculate diff for deleting a node at a specific path
   */
  static calculateDeleteDiff(
    targetPath: number[],
    tree: any,
  ): TreeOperationResult {
    const changes: PathChange[] = [];
    
    // Calculate new focus path
    let newFocusedPath: number[] | null = null;
    
    if (targetPath.length === 0) {
      // Cannot delete root
      return {
        changes: [],
        newFocusedPath: null,
        success: false,
        error: "Cannot delete root node",
      };
    }

    // Primary change: delete the node
    changes.push({
      type: "delete",
      path: [...targetPath],
    });

    // Calculate new focus: try next sibling, then previous sibling, then parent
    const parentPath = targetPath.slice(0, -1);
    const nodeIndex = targetPath[targetPath.length - 1];
    
    // Get parent to check sibling count
    const parent = this.getNodeByPath(tree, parentPath);
    if (parent && parent.children) {
      if (nodeIndex < parent.children.length - 1) {
        // Focus next sibling (same index after deletion)
        newFocusedPath = [...targetPath];
      } else if (nodeIndex > 0) {
        // Focus previous sibling
        newFocusedPath = [...parentPath, nodeIndex - 1];
      } else if (parentPath.length > 0) {
        // Focus parent (only if not root)
        newFocusedPath = [...parentPath];
      }
    }

    changes.push({
      type: "focus",
      path: newFocusedPath || [],
    });

    return {
      changes,
      newFocusedPath,
      success: true,
    };
  }

  /**
   * Calculate diff for indenting a node (moving it as child of previous sibling)
   */
  static calculateIndentDiff(
    targetPath: number[],
    tree: any,
  ): TreeOperationResult {
    const changes: PathChange[] = [];

    if (targetPath.length === 0) {
      return {
        changes: [],
        newFocusedPath: targetPath,
        success: false,
        error: "Cannot indent root node",
      };
    }

    const parentPath = targetPath.slice(0, -1);
    const nodeIndex = targetPath[targetPath.length - 1];

    if (nodeIndex === 0) {
      return {
        changes: [],
        newFocusedPath: targetPath,
        success: false,
        error: "Cannot indent first child",
      };
    }

    // New path: becomes last child of previous sibling
    const previousSiblingPath = [...parentPath, nodeIndex - 1];
    const previousSibling = this.getNodeByPath(tree, previousSiblingPath);
    
    if (!previousSibling) {
      return {
        changes: [],
        newFocusedPath: targetPath,
        success: false,
        error: "Previous sibling not found",
      };
    }

    const newChildIndex = previousSibling.children ? previousSibling.children.length : 0;
    const newPath = [...previousSiblingPath, newChildIndex];

    changes.push({
      type: "move",
      path: [...targetPath],
      newPath: [...newPath],
    });

    changes.push({
      type: "focus",
      path: [...newPath],
    });

    return {
      changes,
      newFocusedPath: newPath,
      success: true,
    };
  }

  /**
   * Calculate diff for outdenting a node (moving it to parent's level)
   */
  static calculateOutdentDiff(
    targetPath: number[],
    tree: any,
  ): TreeOperationResult {
    const changes: PathChange[] = [];

    if (targetPath.length <= 1) {
      return {
        changes: [],
        newFocusedPath: targetPath,
        success: false,
        error: "Cannot outdent top-level node",
      };
    }

    const parentPath = targetPath.slice(0, -1);
    const grandparentPath = parentPath.slice(0, -1);
    const parentIndex = parentPath[parentPath.length - 1];

    // New path: becomes sibling after current parent
    const newPath = [...grandparentPath, parentIndex + 1];

    changes.push({
      type: "move",
      path: [...targetPath],
      newPath: [...newPath],
    });

    changes.push({
      type: "focus",
      path: [...newPath],
    });

    return {
      changes,
      newFocusedPath: newPath,
      success: true,
    };
  }

  /**
   * Calculate diff for moving a node up among siblings
   */
  static calculateMoveUpDiff(
    targetPath: number[],
    tree: any,
  ): TreeOperationResult {
    const changes: PathChange[] = [];

    if (targetPath.length === 0) {
      return {
        changes: [],
        newFocusedPath: targetPath,
        success: false,
        error: "Cannot move root node",
      };
    }

    const parentPath = targetPath.slice(0, -1);
    const nodeIndex = targetPath[targetPath.length - 1];

    if (nodeIndex === 0) {
      return {
        changes: [],
        newFocusedPath: targetPath,
        success: false,
        error: "Already at top of siblings",
      };
    }

    const newPath = [...parentPath, nodeIndex - 1];

    changes.push({
      type: "move",
      path: [...targetPath],
      newPath: [...newPath],
    });

    changes.push({
      type: "focus",
      path: [...newPath],
    });

    return {
      changes,
      newFocusedPath: newPath,
      success: true,
    };
  }

  /**
   * Calculate diff for moving a node down among siblings
   */
  static calculateMoveDownDiff(
    targetPath: number[],
    tree: any,
  ): TreeOperationResult {
    const changes: PathChange[] = [];

    if (targetPath.length === 0) {
      return {
        changes: [],
        newFocusedPath: targetPath,
        success: false,
        error: "Cannot move root node",
      };
    }

    const parentPath = targetPath.slice(0, -1);
    const nodeIndex = targetPath[targetPath.length - 1];
    
    const parent = this.getNodeByPath(tree, parentPath);
    if (!parent || !parent.children || nodeIndex >= parent.children.length - 1) {
      return {
        changes: [],
        newFocusedPath: targetPath,
        success: false,
        error: "Already at bottom of siblings",
      };
    }

    const newPath = [...parentPath, nodeIndex + 1];

    changes.push({
      type: "move",
      path: [...targetPath],
      newPath: [...newPath],
    });

    changes.push({
      type: "focus",
      path: [...newPath],
    });

    return {
      changes,
      newFocusedPath: newPath,
      success: true,
    };
  }

  /**
   * Calculate diff for creating a new node after a target node
   */
  static calculateCreateAfterDiff(
    targetPath: number[],
    nodeData: { body: string; children?: any[]; attachments?: any[] },
    tree: any,
  ): TreeOperationResult {
    const changes: PathChange[] = [];

    const parentPath = targetPath.slice(0, -1);
    const nodeIndex = targetPath[targetPath.length - 1];
    const newPath = [...parentPath, nodeIndex + 1];

    changes.push({
      type: "create",
      path: [...newPath],
      nodeData,
    });

    changes.push({
      type: "focus",
      path: [...newPath],
    });

    return {
      changes,
      newFocusedPath: newPath,
      success: true,
    };
  }

  /**
   * Calculate diff for creating a new child node
   */
  static calculateCreateChildDiff(
    targetPath: number[],
    nodeData: { body: string; children?: any[]; attachments?: any[] },
    tree: any,
  ): TreeOperationResult {
    const changes: PathChange[] = [];
    const newPath = [...targetPath, 0]; // First child

    changes.push({
      type: "create",
      path: [...newPath],
      nodeData,
    });

    changes.push({
      type: "focus",
      path: [...newPath],
    });

    return {
      changes,
      newFocusedPath: newPath,
      success: true,
    };
  }

  /**
   * Helper method to get a node by path
   */
  private static getNodeByPath(tree: any, path: number[]): any {
    let current = tree.root;
    
    for (const index of path) {
      if (!current.children || !current.children[index]) {
        return null;
      }
      current = current.children[index];
    }
    
    return current;
  }
}

/**
 * Utility functions for applying diffs to paths
 */
export class PathDiffApplier {
  /**
   * Apply a set of path changes to update various path-based state
   */
  static applyChangesToPaths(
    changes: PathChange[],
    currentPaths: {
      focused?: number[] | null;
      editing?: number[] | null;
      collapsed?: Set<string>;
    },
  ): {
    focused: number[] | null;
    editing: number[] | null;
    collapsed: Set<string>;
  } {
    let newFocused = currentPaths.focused;
    let newEditing = currentPaths.editing;
    const newCollapsed = new Set(currentPaths.collapsed);

    for (const change of changes) {
      switch (change.type) {
        case "focus":
          newFocused = change.path.length > 0 ? [...change.path] : null;
          break;

        case "move":
          if (change.newPath) {
            // Update focused path if it was the moved node
            if (newFocused && this.pathsEqual(newFocused, change.path)) {
              newFocused = [...change.newPath];
            }
            
            // Update editing path if it was the moved node
            if (newEditing && this.pathsEqual(newEditing, change.path)) {
              newEditing = [...change.newPath];
            }

            // Update collapsed paths
            const oldPathStr = change.path.join(",");
            const newPathStr = change.newPath.join(",");
            if (newCollapsed.has(oldPathStr)) {
              newCollapsed.delete(oldPathStr);
              newCollapsed.add(newPathStr);
            }
          }
          break;

        case "delete":
          // Clear focused/editing if they were the deleted node
          if (newFocused && this.pathsEqual(newFocused, change.path)) {
            newFocused = null;
          }
          if (newEditing && this.pathsEqual(newEditing, change.path)) {
            newEditing = null;
          }

          // Remove from collapsed paths
          const deletedPathStr = change.path.join(",");
          newCollapsed.delete(deletedPathStr);
          break;
      }
    }

    return {
      focused: newFocused ?? null,
      editing: newEditing ?? null,
      collapsed: newCollapsed,
    };
  }

  /**
   * Check if two paths are equal
   */
  private static pathsEqual(path1: number[], path2: number[]): boolean {
    return path1.length === path2.length && 
           path1.every((val, idx) => val === path2[idx]);
  }

  /**
   * Convert path array to string representation
   */
  static pathToString(path: number[]): string {
    return path.join(",");
  }

  /**
   * Convert string representation back to path array
   */
  static stringToPath(pathStr: string): number[] {
    return pathStr === "" ? [] : pathStr.split(",").map(Number);
  }
}