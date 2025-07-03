import type { 
  Tree, 
  Node, 
  Attachment, 
  NodeCreationOptions 
} from "./types.ts";

/**
 * Pure functional operations for Tree manipulation
 * 
 * This module handles the simplified data structure where:
 * - Nodes contain both structure and content
 * - No IDs or separate blocks are needed
 * - Operations work directly with node references
 */
export const TreeOperations = {
  /**
   * Transform nodes in a tree based on a predicate and transformation function
   */
  transformTree(
    tree: Tree,
    predicate: (node: Node, path: Node[]) => boolean,
    transform: (node: Node, path: Node[]) => Node,
    path: Node[] = []
  ): Tree {
    const updateNode = (node: Node, currentPath: Node[]): Node => {
      const nodePath = [...currentPath, node];
      if (predicate(node, currentPath)) {
        return transform(node, currentPath);
      }
      return {
        ...node,
        children: node.children.map(child => updateNode(child, nodePath))
      };
    };

    return {
      root: updateNode(tree.root, path)
    };
  },

  /**
   * Determine appropriate focus after deleting a node
   */
  determineFocusAfterDeletion(
    tree: Tree,
    parentNode: Node,
    deletedIndex: number
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
      root: TreeOperations.createNode({ body: "" })
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
   */
  updateNodeBody(tree: Tree, targetNode: Node, newBody: string): Tree {
    return TreeOperations.transformTree(
      tree,
      (node) => node === targetNode,
      (node) => ({ ...node, body: newBody })
    );
  },

  /**
   * Insert a new node as a child of the specified parent at the given index
   */
  insertNode(tree: Tree, parentNode: Node, newNode: Node, index: number): Tree {
    return TreeOperations.transformTree(
      tree,
      (node) => node === parentNode,
      (node) => {
        const newChildren = [...node.children];
        newChildren.splice(index, 0, newNode);
        return { ...node, children: newChildren };
      }
    );
  },

  /**
   * Remove a node from the tree
   */
  removeNode(tree: Tree, targetNode: Node): Tree {
    const removeFromNode = (node: Node): Node => {
      return {
        ...node,
        children: node.children
          .filter(child => child !== targetNode)
          .map(removeFromNode),
      };
    };

    return {
      root: removeFromNode(tree.root),
    };
  },

  /**
   * Move a node up among its siblings
   */
  moveNodeUp(tree: Tree, targetNode: Node): { success: boolean; tree: Tree } {
    let movePerformed = false;
    
    const newTree = TreeOperations.transformTree(
      tree,
      (node) => {
        const childIndex = node.children.indexOf(targetNode);
        return childIndex > 0;
      },
      (node) => {
        const childIndex = node.children.indexOf(targetNode);
        if (childIndex > 0) {
          movePerformed = true;
          const newChildren = [...node.children];
          [newChildren[childIndex - 1], newChildren[childIndex]] = 
            [newChildren[childIndex], newChildren[childIndex - 1]];
          return { ...node, children: newChildren };
        }
        return node;
      }
    );
    
    return { success: movePerformed, tree: newTree };
  },

  /**
   * Move a node down among its siblings
   */
  moveNodeDown(tree: Tree, targetNode: Node): { success: boolean; tree: Tree } {
    let movePerformed = false;
    
    const newTree = TreeOperations.transformTree(
      tree,
      (node) => {
        const childIndex = node.children.indexOf(targetNode);
        return childIndex !== -1 && childIndex < node.children.length - 1;
      },
      (node) => {
        const childIndex = node.children.indexOf(targetNode);
        if (childIndex !== -1 && childIndex < node.children.length - 1) {
          movePerformed = true;
          const newChildren = [...node.children];
          [newChildren[childIndex], newChildren[childIndex + 1]] = 
            [newChildren[childIndex + 1], newChildren[childIndex]];
          return { ...node, children: newChildren };
        }
        return node;
      }
    );
    
    return { success: movePerformed, tree: newTree };
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
   */
  deleteNode(tree: Tree, targetNode: Node): { success: boolean; tree: Tree; newFocusNode: Node | null } {
    const parentNode = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parentNode) {
      // Can't delete root
      return { success: false, tree, newFocusNode: null };
    }

    const nodeIndex = parentNode.children.indexOf(targetNode);
    if (nodeIndex === -1) {
      return { success: false, tree, newFocusNode: null };
    }

    const newChildren = [...parentNode.children];
    
    // Move children up to parent level if any
    if (targetNode.children.length > 0) {
      newChildren.splice(nodeIndex, 1, ...targetNode.children);
    } else {
      newChildren.splice(nodeIndex, 1);
    }

    // Update the tree
    const updateNode = (node: Node): Node => {
      if (node === parentNode) {
        return { ...node, children: newChildren };
      }
      return {
        ...node,
        children: node.children.map(updateNode)
      };
    };

    const updatedTree = {
      root: updateNode(tree.root)
    };

    // Determine new focus
    const newFocusNode = TreeOperations.determineFocusAfterDeletion(
      updatedTree,
      parentNode,
      nodeIndex
    );

    return { success: true, tree: updatedTree, newFocusNode };
  },

  /**
   * Indent a node (make it a child of the previous sibling)
   */
  indentNode(tree: Tree, targetNode: Node): { success: boolean; tree: Tree } {
    const parentNode = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parentNode) return { success: false, tree };

    const nodeIndex = parentNode.children.indexOf(targetNode);
    if (nodeIndex <= 0) return { success: false, tree }; // Can't indent first child

    const previousSibling = parentNode.children[nodeIndex - 1];

    // Remove node from current position
    const newParentChildren = [...parentNode.children];
    newParentChildren.splice(nodeIndex, 1);

    // Add as child of previous sibling
    const newPreviousSibling = {
      ...previousSibling,
      children: [...previousSibling.children, targetNode]
    };
    newParentChildren[nodeIndex - 1] = newPreviousSibling;

    // Update the tree
    const updatedTree = TreeOperations.transformTree(
      tree,
      (node) => node === parentNode,
      (node) => ({ ...node, children: newParentChildren })
    );

    return { success: true, tree: updatedTree };
  },

  /**
   * Outdent a node (move it up to parent's level)
   */
  outdentNode(tree: Tree, targetNode: Node): { success: boolean; tree: Tree } {
    const parentNode = TreeOperations.findParentNode(tree.root, targetNode);
    if (!parentNode) return { success: false, tree };

    const grandParentNode = TreeOperations.findParentNode(tree.root, parentNode);
    if (!grandParentNode) return { success: false, tree }; // Already at root level

    const nodeIndex = parentNode.children.indexOf(targetNode);
    const parentIndex = grandParentNode.children.indexOf(parentNode);
    
    if (nodeIndex === -1 || parentIndex === -1) return { success: false, tree };

    // Remove from parent
    const newParentChildren = [...parentNode.children];
    newParentChildren.splice(nodeIndex, 1);

    // Add to grandparent after parent
    const newGrandParentChildren = [...grandParentNode.children];
    newGrandParentChildren.splice(parentIndex + 1, 0, targetNode);

    // Update the tree - we need a custom approach here since we're updating two levels
    const updateNode = (node: Node): Node => {
      if (node === parentNode) {
        return { ...node, children: newParentChildren };
      }
      if (node === grandParentNode) {
        return { ...node, children: newGrandParentChildren };
      }
      return {
        ...node,
        children: node.children.map(updateNode)
      };
    };

    return { success: true, tree: { root: updateNode(tree.root) } };
  },

  /**
   * Convert Tree structure to markdown string
   */
  toMarkdown(tree: Tree): string {
    const renderNode = (node: Node, level: number = 0): string => {
      const indent = "  ".repeat(level);
      const line = `${indent}- ${node.body}`;
      
      const childLines = node.children.map(child => renderNode(child, level + 1)).join("\n");
      return childLines ? `${line}\n${childLines}` : line;
    };
    
    return tree.root.children.map(child => renderNode(child)).join("\n");
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
        children: children.map(buildNode)
      };
    };

    const finalRootChildren = rootChildren.map(buildNode);

    return {
      root: TreeOperations.createNode({
        body: "",
        children: finalRootChildren
      })
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
      const result = TreeOperations.findNodePath(child, targetNode, [...path, root]);
      if (result) return result;
    }

    return null;
  }
};