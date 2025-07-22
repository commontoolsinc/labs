import type {
  Attachment,
  MutableNode,
  MutableTree,
  Node,
  NodeCreationOptions,
  Tree,
} from "./types.ts";

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
   */
  createNode(options: NodeCreationOptions): Node {
    return {
      body: options.body,
      children: options.children || [],
      attachments: options.attachments || [],
    };
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
   * Find the parent node containing a child
   */
  findParentNode(node: Node, targetNode: Node): Node | null {
    if (node.children.includes(targetNode)) {
      return node;
    }

    for (const child of node.children) {
      const found = TreeOperations.findParentNode(child, targetNode);
      if (found) return found;
    }

    return null;
  },

  /**
   * Get all nodes in the tree in depth-first order
   */
  getAllNodes(node: Node): Node[] {
    const result: Node[] = [node];
    for (const child of node.children) {
      result.push(...TreeOperations.getAllNodes(child));
    }
    return result;
  },

  /**
   * Get the index of a node in its parent's children array
   */
  getNodeIndex(parent: Node, targetNode: Node): number {
    return parent.children.indexOf(targetNode);
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
   * Move a node up among its siblings
   * Mutates the tree structure directly
   */
  moveNodeUp(tree: Tree, targetNode: Node): void {
    const parentNode = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parentNode) {
      throw new Error("Cannot move node up: node has no parent");
    }

    const childIndex = parentNode.children.indexOf(targetNode);
    if (childIndex <= 0) {
      throw new Error("Cannot move node up: already at first position");
    }

    // Mutate the children array directly
    const mutableParent = parentNode as MutableNode;
    const mutableChildren = [...mutableParent.children];
    [mutableChildren[childIndex - 1], mutableChildren[childIndex]] = [
      mutableChildren[childIndex],
      mutableChildren[childIndex - 1],
    ];
    mutableParent.children = mutableChildren;

    // Operation completed successfully
  },

  /**
   * Move a node down among its siblings
   * Mutates the tree structure directly
   */
  moveNodeDown(tree: Tree, targetNode: Node): void {
    const parentNode = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parentNode) {
      throw new Error("Cannot move node down: node has no parent");
    }

    const childIndex = parentNode.children.indexOf(targetNode);
    if (childIndex === -1 || childIndex >= parentNode.children.length - 1) {
      throw new Error("Cannot move node down: already at last position");
    }

    // Mutate the children array directly
    const mutableParent = parentNode as MutableNode;
    const mutableChildren = [...mutableParent.children];
    [mutableChildren[childIndex], mutableChildren[childIndex + 1]] = [
      mutableChildren[childIndex + 1],
      mutableChildren[childIndex],
    ];
    mutableParent.children = mutableChildren;

    // Operation completed successfully
  },

  /**
   * Get all visible nodes in the tree (respecting collapsed state)
   */
  getAllVisibleNodes(node: Node, collapsedNodes: Set<Node>): Node[] {
    const result: Node[] = [];
    const traverse = (currentNode: Node) => {
      result.push(currentNode);
      if (!collapsedNodes.has(currentNode)) {
        for (const child of currentNode.children) {
          traverse(child);
        }
      }
    };
    for (const child of node.children) {
      traverse(child);
    }
    return result;
  },

  /**
   * Delete a node from the tree
   * Mutates the tree structure directly
   */
  deleteNode(tree: Tree, targetNode: Node): void {
    const parentNode = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parentNode) {
      throw new Error("Cannot delete root node");
    }

    const nodeIndex = parentNode.children.indexOf(targetNode);
    if (nodeIndex === -1) {
      throw new Error("Node not found in parent");
    }

    // Mutate parent's children array directly
    const mutableParent = parentNode as MutableNode;
    const newChildren = [...mutableParent.children];

    // Move children up to parent level if any
    if (targetNode.children.length > 0) {
      newChildren.splice(nodeIndex, 1, ...targetNode.children);
    } else {
      newChildren.splice(nodeIndex, 1);
    }

    mutableParent.children = newChildren;

    // Operation completed successfully
    // Note: Focus handling is managed by the calling component
  },

  /**
   * Indent a node (make it a child of the previous sibling)
   * Mutates the tree structure directly
   */
  indentNode(tree: Tree, targetNode: Node): void {
    const parentNode = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parentNode) {
      throw new Error("Cannot indent node: node has no parent");
    }

    const nodeIndex = parentNode.children.indexOf(targetNode);
    if (nodeIndex <= 0) {
      throw new Error("Cannot indent first child node");
    }

    const previousSibling = parentNode.children[nodeIndex - 1];

    // Remove targetNode from parent's children
    const mutableParent = parentNode as MutableNode;
    const mutableChildren = [...mutableParent.children];
    mutableChildren.splice(nodeIndex, 1);
    mutableParent.children = mutableChildren;

    // Add targetNode to previous sibling's children
    const mutableSibling = previousSibling as MutableNode;
    mutableSibling.children = [...mutableSibling.children, targetNode];

    // Operation completed successfully
  },

  /**
   * Outdent a node (move it up to parent's level)
   * Mutates the tree structure directly
   */
  outdentNode(tree: Tree, targetNode: Node): void {
    const parentNode = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parentNode) {
      throw new Error("Cannot outdent node: node has no parent");
    }

    const grandParentNode = TreeOperations.findParentNode(
      tree.root,
      parentNode,
    );
    if (!grandParentNode) {
      throw new Error("Cannot outdent node: already at root level");
    }

    const nodeIndex = parentNode.children.indexOf(targetNode);
    const parentIndex = grandParentNode.children.indexOf(parentNode);

    if (nodeIndex === -1 || parentIndex === -1) {
      throw new Error("Node structure is inconsistent");
    }

    // Remove targetNode from parent's children
    const mutableParent = parentNode as MutableNode;
    const mutableParentChildren = [...mutableParent.children];
    mutableParentChildren.splice(nodeIndex, 1);
    mutableParent.children = mutableParentChildren;

    // Add targetNode to grandparent after parent
    const mutableGrandParent = grandParentNode as MutableNode;
    const mutableGrandParentChildren = [...mutableGrandParent.children];
    mutableGrandParentChildren.splice(parentIndex + 1, 0, targetNode);
    mutableGrandParent.children = mutableGrandParentChildren;

    // Operation completed successfully
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
};
