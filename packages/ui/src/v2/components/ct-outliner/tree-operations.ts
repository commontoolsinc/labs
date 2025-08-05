import type {
  Attachment,
  MutableNode,
  MutableTree,
  Node,
  NodeCreationOptions,
  Tree,
} from "./types.ts";
import { ID, Cell } from "@commontools/runner";

/**
 * Executes a mutation on a Cell within a transaction
 * @param cell - The Cell to mutate
 * @param mutator - Function that performs the mutation
 */
async function mutateCell<T>(
  cell: Cell<T>,
  mutator: (cell: Cell<T>) => void,
): Promise<void> {
  const tx = cell.runtime.edit();
  mutator(cell.withTx(tx));
  await tx.commit();
}

/**
 * Create a clean deep copy of a node to avoid Cell proxy issues
 * Recursively copies children and assigns new IDs to prevent reference conflicts
 */
export function createCleanNodeCopy(node: Node): Node {
  return {
    [ID]: crypto.randomUUID(),
    body: node.body,
    attachments: [...(node.attachments || [])],
    children: node.children.map(child => createCleanNodeCopy(child)),
  };
}

/**
 * Pure functional operations for Tree manipulation
 *
 * This module provides pure functions for tree operations that work with:
 * - Nodes containing both structure and content
 * - Direct node references without IDs
 * - Immutable transformations that preserve reference equality when possible
 *
 * These operations are designed to work with CellController for reactive state management.
 * When used with CellController, changes automatically propagate to connected components
 * without manual emitChange() calls.
 */
export const TreeOperations = {
  /**
   * Transform nodes in a tree based on a predicate and transformation function
   * Only creates new objects when changes are needed to preserve reference equality
   */
  transformTree(
    tree: Tree,
    predicate: (node: Node, path: Node[]) => boolean,
    transform: (node: Node, path: Node[]) => Node,
    path: Node[] = [],
  ): Tree {
    const updateNode = (node: Node, currentPath: Node[]): Node => {
      const nodePath = [...currentPath, node];
      if (predicate(node, currentPath)) {
        return transform(node, currentPath);
      }

      // Only update children if any child needs updating
      let needsUpdate = false;
      const newChildren = node.children.map((child) => {
        const updatedChild = updateNode(child, nodePath);
        if (updatedChild !== child) {
          needsUpdate = true;
        }
        return updatedChild;
      });

      if (needsUpdate) {
        return {
          ...node,
          children: newChildren,
        };
      }

      return node; // Return same reference if no changes
    };

    const newRoot = updateNode(tree.root, path);
    if (newRoot === tree.root) {
      return tree; // Return same tree if no changes
    }

    return {
      root: newRoot,
    };
  },

  /**
   * Determine appropriate focus after deleting a node
   */
  determineFocusAfterDeletion(
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
    if (deletedIndex < siblings.length && siblings[deletedIndex + 1]) {
      return siblings[deletedIndex + 1];
    }

    // Fall back to first visible node
    const allNodes = TreeOperations.getAllVisibleNodes(tree.root, new Set());
    return allNodes.length > 0 ? allNodes[0] : null;
  },

  /**
   * Create a new node with given options
   * Includes [ID] property required for Cell array operations
   */
  createNode(options: NodeCreationOptions): Node {
    return {
      [ID]: crypto.randomUUID(),
      body: options.body,
      children: options.children || [],
      attachments: options.attachments || [],
    } as Node;
  },

  /**
   * Create an empty tree with a single root node
   */
  createEmptyTree(): Tree {
    return {
      root: TreeOperations.createNode({ body: "" }),
    };
  },

  /**
   * Find a node in the tree structure
   */
  findNode(node: Node, targetNode: Node): Node | null {
    if (node === targetNode) return node;

    for (const child of node.children) {
      const found = TreeOperations.findNode(child, targetNode);
      if (found) return found;
    }

    return null;
  },

  /**
   * Find the parent node containing a child (for regular Nodes)
   */
  findParentNode(node: Node, targetNode: Node): Node | null {
    for (const child of node.children) {
      if (child === targetNode) {
        return node;
      }

      const found = TreeOperations.findParentNode(child, targetNode);
      if (found) return found;
    }

    return null;
  },

  /**
   * Find the parent node containing a child (for Cell<Node>)
   */
  findParentNodeCell(node: Cell<Node>, targetNode: Cell<Node>): Cell<Node> | null {
    const nodeChildren = node.key("children");
    const childrenArray = nodeChildren.getAsQueryResult();
    
    for (let i = 0; i < childrenArray.length; i++) {
      const childCell = nodeChildren.key(i);
      if (childCell.equals(targetNode)) {
        return node;
      }

      const found = TreeOperations.findParentNodeCell(childCell, targetNode);
      if (found) return found;
    }

    return null;
  },

  /**
   * Get all nodes in the tree in depth-first order
   * Enhanced with defensive checks for corrupted node objects
   */
  getAllNodes(node: Node): Node[] {
    if (!node || typeof node !== "object") {
      console.warn("Invalid node encountered in getAllNodes:", node);
      return [];
    }

    const result: Node[] = [node];

    // Ensure children array exists and is valid
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child) {
          result.push(...TreeOperations.getAllNodes(child));
        }
      }
    }

    return result;
  },

  /**
   * Get the index of a node in its parent's children array
   */
  getNodeIndex(parent: Cell<Node>, targetNode: Cell<Node>): number {
    const parentChildren = parent.key("children");
    const childrenArray = parentChildren.getAsQueryResult();
    
    for (let i = 0; i < childrenArray.length; i++) {
      const childCell = parentChildren.key(i);
      if (childCell.equals(targetNode)) {
        return i;
      }
    }
    
    return -1;
  },

  /**
   * Navigate to a node's children Cell by path
   */
  getChildrenCellByPath(rootCell: Cell<Node>, nodePath: number[]): Cell<Node[]> {
    let childrenCell = rootCell.key("children") as Cell<Node[]>;
    for (const pathIndex of nodePath) {
      childrenCell = childrenCell.key(pathIndex).key("children") as Cell<Node[]>;
    }
    return childrenCell;
  },

  /**
   * Update a node's content
   * Mutates the node directly
   */
  updateNodeBody(tree: Tree, targetNode: Node, newBody: string): Tree {
    const mutableNode = targetNode as MutableNode;
    mutableNode.body = newBody;
    return tree;
  },

  /**
   * Insert a new node as a child of the specified parent at the given index
   * Mutates the tree structure directly
   */
  insertNode(tree: Tree, parentNode: Node, newNode: Node, index: number): Tree {
    const mutableParent = parentNode as MutableNode;
    const mutableChildren = [...mutableParent.children];
    mutableChildren.splice(index, 0, newNode);
    mutableParent.children = mutableChildren;
    return tree;
  },

  /**
   * Remove a node from the tree
   * Mutates the tree structure directly
   */
  removeNode(tree: Tree, targetNode: Node): Tree {
    const removeFromNode = (node: Node): void => {
      const mutableNode = node as MutableNode;
      mutableNode.children = mutableNode.children.filter((child: Node) => {
        if (child === targetNode) {
          return false;
        }
        removeFromNode(child);
        return true;
      });
    };

    removeFromNode(tree.root);
    return tree;
  },

  /**
   * Move a node up among its siblings using Cell operations
   * @param rootCell - The root Cell of the tree
   * @param nodeCell - The Cell for the node to move up
   * @param nodePath - Path to the node (for focus management)
   * @returns Promise<boolean> indicating success
   */
  async moveNodeUpCell(
    rootCell: Cell<Node>,
    nodeCell: Cell<Node>,
    nodePath: number[]
  ): Promise<boolean> {
    const parentNode = TreeOperations.findParentNodeCell(rootCell, nodeCell);
    if (!parentNode) {
      return false; // Cannot move node up: node has no parent
    }

    const childIndex = TreeOperations.getNodeIndex(parentNode, nodeCell);
    if (childIndex <= 0) {
      return false; // Cannot move node up: already at first position
    }

    const parentChildrenCell = parentNode.key("children") as Cell<Node[]>;

    // V-DOM style: swap positions directly
    await mutateCell(parentChildrenCell, (cell) => {
      const currentChildren = cell.get();
      const newChildren = [...currentChildren];

      // Swap the node with the previous one
      [newChildren[childIndex - 1], newChildren[childIndex]] = [
        newChildren[childIndex],
        newChildren[childIndex - 1],
      ];

      cell.set(newChildren);
    });

    return true;
  },

  /**
   * Move a node down among its siblings using Cell operations
   * @param rootCell - The root Cell of the tree
   * @param nodeCell - The Cell for the node to move down
   * @param nodePath - Path to the node (for focus management)
   * @returns Promise<boolean> indicating success
   */
  async moveNodeDownCell(
    rootCell: Cell<Node>,
    nodeCell: Cell<Node>,
    nodePath: number[]
  ): Promise<boolean> {
    const parentNode = TreeOperations.findParentNodeCell(rootCell, nodeCell);
    if (!parentNode) {
      return false; // Cannot move node down: node has no parent
    }

    const childIndex = TreeOperations.getNodeIndex(parentNode, nodeCell);
    const parentChildren = parentNode.key("children").getAsQueryResult();
    if (childIndex === -1 || childIndex >= parentChildren.length - 1) {
      return false; // Cannot move node down: already at last position
    }

    const parentChildrenCell = parentNode.key("children") as Cell<Node[]>;

    // V-DOM style: swap positions directly
    await mutateCell(parentChildrenCell, (cell) => {
      const currentChildren = cell.get();
      const newChildren = [...currentChildren];

      // Swap the node with the next one
      [newChildren[childIndex], newChildren[childIndex + 1]] = [
        newChildren[childIndex + 1],
        newChildren[childIndex],
      ];

      cell.set(newChildren);
    });

    return true;
  },

  /**
   * Get all visible nodes in the tree (respecting collapsed state)
   * Enhanced with defensive checks for corrupted node objects
   */
  getAllVisibleNodes(node: Node, collapsedNodes: Set<Node>): Node[] {
    const result: Node[] = [];
    const traverse = (currentNode: Node) => {
      // Defensive check for valid node structure
      if (!currentNode || typeof currentNode !== "object") {
        console.warn(
          "Invalid node encountered in tree traversal:",
          currentNode,
        );
        return;
      }

      result.push(currentNode);

      // Ensure children array exists and is valid
      if (
        !collapsedNodes.has(currentNode) &&
        currentNode.children &&
        Array.isArray(currentNode.children)
      ) {
        for (const child of currentNode.children) {
          if (child) {
            traverse(child);
          }
        }
      }
    };

    // Ensure root node has valid children array
    if (node && node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child) {
          traverse(child);
        }
      }
    }

    return result;
  },

  /**
   * Delete a node from the tree using Cell operations
   * @param rootCell - The root Cell of the tree
   * @param nodeCell - The Cell for the node to delete
   * @param nodePath - Path to the node (for focus management)
   * @returns Promise resolving to new focus path or null
   */
  async deleteNodeCell(
    rootCell: Cell<Node>, 
    nodeCell: Cell<Node>,
    nodePath: number[]
  ): Promise<number[] | null> {
    const parentNode = TreeOperations.findParentNodeCell(rootCell, nodeCell);
    if (!parentNode) {
      console.error("Cannot delete root node");
      return null;
    }

    const nodeIndex = TreeOperations.getNodeIndex(parentNode, nodeCell);
    if (nodeIndex === -1) {
      console.error("Node not found in parent");
      return null;
    }

    const parentChildrenCell = parentNode.key("children") as Cell<Node[]>;
    const node = nodeCell.get();

    await mutateCell(parentChildrenCell, (cell) => {
      const currentChildren = cell.get();
      
      // Create clean copies of all nodes that should remain
      let newChildren: Node[] = [];
      
      // Add nodes before the deleted one
      for (let i = 0; i < nodeIndex; i++) {
        newChildren.push(createCleanNodeCopy(currentChildren[i]));
      }
      
      // Add promoted children if any
      if (node.children.length > 0) {
        for (const child of node.children) {
          newChildren.push(createCleanNodeCopy(child));
        }
      }
      
      // Add nodes after the deleted one  
      for (let i = nodeIndex + 1; i < currentChildren.length; i++) {
        newChildren.push(createCleanNodeCopy(currentChildren[i]));
      }

      cell.set(newChildren);
    });

    // Calculate new focus after deletion - need to check the actual updated array
    const parentPath = nodePath.slice(0, -1);
    const updatedChildren = parentNode.key("children").getAsQueryResult();
    
    if (nodeIndex > 0 && updatedChildren.length > nodeIndex - 1) {
      // Focus previous sibling
      return [...parentPath, nodeIndex - 1];
    } else if (updatedChildren.length > 0) {
      // Focus first available sibling (or promoted child)
      return [...parentPath, Math.min(nodeIndex, updatedChildren.length - 1)];
    } else if (parentPath.length > 0) {
      // Focus parent if no children left
      return parentPath;
    } else {
      // No nodes left
      return null;
    }
  },

  /**
   * Indent a node (make it a child of the previous sibling) using Cell operations
   * @param rootCell - The root Cell of the tree
   * @param nodePath - Path to the node to indent
   * @returns Promise resolving to new focus path or null if operation failed
   */
  async indentNodeCell(
    rootCell: Cell<Node>,
    nodePath: number[]
  ): Promise<number[] | null> {
    // Check if we can indent (must not be first child)
    if (nodePath.length === 0 || nodePath[nodePath.length - 1] === 0) {
      console.error("Cannot indent first child node or root node");
      return null;
    }

    const parentPath = nodePath.slice(0, -1);
    const nodeIndex = nodePath[nodePath.length - 1];
    const previousSiblingIndex = nodeIndex - 1;

    // Navigate to parent's children Cell
    const parentChildrenCell = TreeOperations.getChildrenCellByPath(rootCell, parentPath);

    // Navigate to sibling's children Cell
    const siblingChildrenCell = parentChildrenCell.key(previousSiblingIndex).key("children") as Cell<Node[]>;

    // Get the node to move before we start modifying anything
    const nodeToMove = parentChildrenCell.get()[nodeIndex];

    // Use the simpler V-DOM style pattern like moveNodeUpCell
    await mutateCell(parentChildrenCell, (parentCell) => {
      const currentParentChildren = parentCell.get();
      
      // Remove node from parent children
      const newParentChildren = [
        ...currentParentChildren.slice(0, nodeIndex),
        ...currentParentChildren.slice(nodeIndex + 1),
      ];
      
      parentCell.set(newParentChildren);
    });

    // Add node to sibling children
    await mutateCell(siblingChildrenCell, (siblingCell) => {
      const currentSiblingChildren = siblingCell.get();
      const newSiblingChildren = [...currentSiblingChildren, nodeToMove];
      siblingCell.set(newSiblingChildren);
    });

    // Return new focused path
    const siblingPath = [...parentPath, previousSiblingIndex];
    const updatedSiblingChildren = siblingChildrenCell.get();
    return [...siblingPath, updatedSiblingChildren.length - 1]; // -1 because we just added the node
  },

  /**
   * Outdent a node (move it up to parent's level) using Cell operations
   * @param rootCell - The root Cell of the tree
   * @param nodePath - Path to the node to outdent
   * @returns Promise resolving to new focus path or null if operation failed
   */
  async outdentNodeCell(
    rootCell: Cell<Node>,
    nodePath: number[]
  ): Promise<number[] | null> {
    // Check if we can outdent (must have grandparent)
    if (nodePath.length < 2) {
      console.error("Cannot outdent node: already at root level or is root");
      return null;
    }

    const parentPath = nodePath.slice(0, -1);
    const grandParentPath = parentPath.slice(0, -1);
    const nodeIndex = nodePath[nodePath.length - 1];
    const parentIndex = parentPath[parentPath.length - 1];

    // Navigate to parent's children Cell (source)
    const parentChildrenCell = TreeOperations.getChildrenCellByPath(rootCell, parentPath);

    // Navigate to grandparent's children Cell (destination)
    const grandParentChildrenCell = TreeOperations.getChildrenCellByPath(rootCell, grandParentPath);

    // Get values and create clean copies instead of moving proxy objects
    const parentChildren = parentChildrenCell.get();
    const grandParentChildren = grandParentChildrenCell.get();
    const nodeToMove = parentChildren[nodeIndex];
    
    // Create a clean deep copy of the node to avoid proxy issues
    const cleanNodeCopy = createCleanNodeCopy(nodeToMove);

    const tx = rootCell.runtime.edit();

    // Remove from parent children
    const newParentChildren = [
      ...parentChildren.slice(0, nodeIndex),
      ...parentChildren.slice(nodeIndex + 1),
    ];
    parentChildrenCell.withTx(tx).set(newParentChildren);

    // Insert clean copy into grandparent children after parent
    const newGrandParentChildren = [
      ...grandParentChildren.slice(0, parentIndex + 1),
      cleanNodeCopy,
      ...grandParentChildren.slice(parentIndex + 1),
    ];
    grandParentChildrenCell.withTx(tx).set(newGrandParentChildren);

    await tx.commit();

    // Return new focused path
    return [...grandParentPath, parentIndex + 1];
  },

  /**
   * Convert Tree structure to markdown string
   */
  toMarkdown(tree: Tree): string {
    const renderNode = (node: Node, level: number = 0): string => {
      const indent = "  ".repeat(level);
      const line = `${indent}- ${node.body}`;

      const childLines = node.children.map((child) =>
        renderNode(child, level + 1)
      ).join("\n");
      return childLines ? `${line}\n${childLines}` : line;
    };

    return tree.root.children.map((child) => renderNode(child)).join("\n");
  },

  /**
   * Parse markdown string to tree structure
   */
  parseMarkdownToTree(markdown: string): Tree {
    if (!markdown.trim()) return TreeOperations.createEmptyTree();

    const lines = markdown.split("\n");
    const nodeMap = new Map<Node, Node[]>(); // Track children for each node
    const stack: { node: Node; level: number }[] = [];
    const rootChildren: Node[] = [];

    for (const line of lines) {
      const match = line.match(/^(\s*)-\s(.*)$/);
      if (!match) continue;

      const [, indent, content] = match;
      const level = Math.floor(indent.length / 2);
      const newNode = TreeOperations.createNode({ body: content });
      nodeMap.set(newNode, []);

      // Remove items from stack that are at same or deeper level
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length === 0) {
        // This is a root level node
        rootChildren.push(newNode);
      } else {
        // Add as child of the parent
        const parent = stack[stack.length - 1].node;
        const parentChildren = nodeMap.get(parent) || [];
        nodeMap.set(parent, [...parentChildren, newNode]);
      }

      stack.push({ node: newNode, level });
    }

    // Build the final tree structure with the children
    const buildNode = (node: Node): Node => {
      const children = nodeMap.get(node) || [];
      return {
        ...node,
        children: children.map(buildNode),
      };
    };

    const finalRootChildren = rootChildren.map(buildNode);

    return {
      root: TreeOperations.createNode({
        body: "",
        children: finalRootChildren,
      }),
    };
  },

  /**
   * Find the path to a node (list of nodes from root to target)
   */
  findNodePath(root: Node, targetNode: Node, path: Node[] = []): Node[] | null {
    if (root === targetNode) {
      return [...path, root];
    }

    for (const child of root.children) {
      const result = TreeOperations.findNodePath(child, targetNode, [
        ...path,
        root,
      ]);
      if (result) return result;
    }

    return null;
  },

  /**
   * Check if a node has a checkbox prefix
   */
  hasCheckbox(node: Node): boolean {
    return /^\s*\[[ x]?\]\s*/.test(node.body);
  },

  /**
   * Check if a node's checkbox is checked
   */
  isCheckboxChecked(node: Node): boolean {
    return /^\s*\[x\]\s*/.test(node.body);
  },

  /**
   * Toggle the checkbox state of a node
   * Cycles: unchecked ([] or [ ]) → checked ([x]) → unchecked ([ ])
   */
  toggleCheckbox(tree: Tree, targetNode: Node): void {
    const mutableNode = targetNode as MutableNode;

    if (TreeOperations.hasCheckbox(targetNode)) {
      // Toggle existing checkbox
      if (TreeOperations.isCheckboxChecked(targetNode)) {
        // Checked -> Unchecked (normalize to [ ])
        mutableNode.body = mutableNode.body.replace(/^\s*\[x\]\s*/, "[ ] ");
      } else {
        // Unchecked -> Checked
        mutableNode.body = mutableNode.body.replace(/^\s*\[[ ]?\]\s*/, "[x] ");
      }
    } else {
      // Add checkbox if none exists
      mutableNode.body = "[ ] " + mutableNode.body;
    }
  },

  /**
   * Get the body text without the checkbox prefix
   */
  getBodyWithoutCheckbox(node: Node): string {
    return node.body.replace(/^\s*\[[ x]?\]\s*/, "");
  },

  /**
   * Extract checkbox state from node body
   * Returns: 'checked', 'unchecked', or null if no checkbox
   */
  getCheckboxState(node: Node): "checked" | "unchecked" | null {
    if (TreeOperations.isCheckboxChecked(node)) {
      return "checked";
    } else if (TreeOperations.hasCheckbox(node)) {
      return "unchecked";
    }
    return null;
  },
};
