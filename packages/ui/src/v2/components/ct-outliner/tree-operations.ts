import type { 
  Tree, 
  Node, 
  Block, 
  Attachment, 
  BlockCreationOptions, 
  NodeCreationOptions 
} from "./types.ts";

/**
 * Pure functional operations for Tree manipulation
 * 
 * This module handles the new data structure where:
 * - Nodes define the tree structure and reference blocks by ID
 * - Blocks contain the actual content and attachments
 * - The same block can appear multiple times in the tree (Roam-style block references)
 */
export const TreeOperations = {
  /**
   * Create a unique ID for nodes and blocks
   */
  createId(): string {
    return crypto.randomUUID();
  },

  /**
   * Transform nodes in a tree based on a predicate and transformation function
   */
  transformTree(
    tree: Tree,
    predicate: (node: Node) => boolean,
    transform: (node: Node) => Node
  ): Tree {
    const updateNode = (node: Node): Node => {
      if (predicate(node)) {
        return transform(node);
      }
      return {
        ...node,
        children: node.children.map(updateNode)
      };
    };

    return {
      ...tree,
      root: updateNode(tree.root)
    };
  },

  /**
   * Determine appropriate focus after deleting a node
   */
  determineFocusAfterDeletion(
    tree: Tree,
    parentNode: Node,
    deletedIndex: number
  ): string | null {
    const siblings = parentNode.children;
    
    // Try previous sibling first
    if (deletedIndex > 0 && siblings[deletedIndex - 1]) {
      return siblings[deletedIndex - 1].id;
    }
    
    // Try next sibling
    if (deletedIndex < siblings.length && siblings[deletedIndex + 1]) {
      return siblings[deletedIndex + 1].id;
    }
    
    // Fall back to first visible node
    const allNodes = TreeOperations.getAllVisibleNodes(tree.root, new Set());
    return allNodes.length > 0 ? allNodes[0].id : null;
  },

  /**
   * Create a new block with given options
   */
  createBlock(options: BlockCreationOptions): Block {
    return {
      id: options.id || TreeOperations.createId(),
      body: options.body,
      attachments: options.attachments || [],
    };
  },

  /**
   * Create a new node with given options
   */
  createNode(options: NodeCreationOptions): Node {
    return {
      id: options.id || TreeOperations.createId(),
      children: options.children || [],
    };
  },

  /**
   * Create an empty tree with a single root node and block
   */
  createEmptyTree(): Tree {
    const blockId = TreeOperations.createId();
    const rootBlock = TreeOperations.createBlock({ body: "", id: blockId });
    const rootNode = TreeOperations.createNode({ id: blockId });

    return {
      root: rootNode,
      blocks: [rootBlock],
      attachments: [],
    };
  },

  /**
   * Find a block by ID in the tree
   */
  findBlock(tree: Tree, blockId: string): Block | null {
    return tree.blocks.find(block => block.id === blockId) || null;
  },

  /**
   * Find a node by ID in the tree structure
   */
  findNode(node: Node, nodeId: string): Node | null {
    if (node.id === nodeId) return node;
    
    for (const child of node.children) {
      const found = TreeOperations.findNode(child, nodeId);
      if (found) return found;
    }
    
    return null;
  },

  /**
   * Find the parent node containing a child with the given ID
   */
  findParentNode(node: Node, targetId: string): Node | null {
    if (node.children.some(child => child.id === targetId)) {
      return node;
    }
    
    for (const child of node.children) {
      const found = TreeOperations.findParentNode(child, targetId);
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
  getNodeIndex(parent: Node, nodeId: string): number {
    return parent.children.findIndex(child => child.id === nodeId);
  },

  /**
   * Update a block's content
   */
  updateBlock(tree: Tree, blockId: string, newBody: string): Tree {
    const updatedBlocks = tree.blocks.map(block =>
      block.id === blockId ? { ...block, body: newBody } : block
    );

    return {
      ...tree,
      blocks: updatedBlocks,
    };
  },

  /**
   * Add a new block to the tree
   */
  addBlock(tree: Tree, block: Block): Tree {
    return {
      ...tree,
      blocks: [...tree.blocks, block],
    };
  },

  /**
   * Remove a block from the tree
   */
  removeBlock(tree: Tree, blockId: string): Tree {
    return {
      ...tree,
      blocks: tree.blocks.filter(block => block.id !== blockId),
    };
  },

  /**
   * Insert a new node as a child of the specified parent at the given index
   */
  insertNode(tree: Tree, parentId: string, newNode: Node, index: number): Tree {
    return TreeOperations.transformTree(
      tree,
      (node) => node.id === parentId,
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
  removeNode(tree: Tree, nodeId: string): Tree {
    const removeFromNode = (node: Node): Node => {
      return {
        ...node,
        children: node.children
          .filter(child => child.id !== nodeId)
          .map(removeFromNode),
      };
    };

    return {
      ...tree,
      root: removeFromNode(tree.root),
    };
  },

  /**
   * Move a node up among its siblings
   */
  moveNodeUp(tree: Tree, nodeId: string): { success: boolean; tree: Tree } {
    let movePerformed = false;
    
    const newTree = TreeOperations.transformTree(
      tree,
      (node) => {
        const childIndex = node.children.findIndex(child => child.id === nodeId);
        return childIndex > 0;
      },
      (node) => {
        const childIndex = node.children.findIndex(child => child.id === nodeId);
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
  moveNodeDown(tree: Tree, nodeId: string): { success: boolean; tree: Tree } {
    let movePerformed = false;
    
    const newTree = TreeOperations.transformTree(
      tree,
      (node) => {
        const childIndex = node.children.findIndex(child => child.id === nodeId);
        return childIndex !== -1 && childIndex < node.children.length - 1;
      },
      (node) => {
        const childIndex = node.children.findIndex(child => child.id === nodeId);
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
  getAllVisibleNodes(node: Node, collapsedNodes: Set<string>): Node[] {
    const result: Node[] = [];
    const traverse = (currentNode: Node) => {
      result.push(currentNode);
      if (!collapsedNodes.has(currentNode.id)) {
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
  deleteNode(tree: Tree, nodeId: string): { success: boolean; tree: Tree; newFocusId: string | null } {
    const parentNode = TreeOperations.findParentNode(tree.root, nodeId);
    if (!parentNode) {
      // Can't delete root
      return { success: false, tree, newFocusId: null };
    }

    const nodeIndex = parentNode.children.findIndex(child => child.id === nodeId);
    if (nodeIndex === -1) {
      return { success: false, tree, newFocusId: null };
    }

    const nodeToDelete = parentNode.children[nodeIndex];
    const newChildren = [...parentNode.children];
    
    // Move children up to parent level if any
    if (nodeToDelete.children.length > 0) {
      newChildren.splice(nodeIndex, 1, ...nodeToDelete.children);
    } else {
      newChildren.splice(nodeIndex, 1);
    }

    // Update the tree
    const updateNode = (node: Node): Node => {
      if (node.id === parentNode.id) {
        return { ...node, children: newChildren };
      }
      return {
        ...node,
        children: node.children.map(updateNode)
      };
    };

    const updatedTree = {
      ...tree,
      root: updateNode(tree.root),
      // Remove the block as well
      blocks: tree.blocks.filter(block => block.id !== nodeId)
    };

    // Determine new focus
    const newFocusId = TreeOperations.determineFocusAfterDeletion(
      updatedTree,
      parentNode,
      nodeIndex
    );

    return { success: true, tree: updatedTree, newFocusId };
  },

  /**
   * Indent a node (make it a child of the previous sibling)
   */
  indentNode(tree: Tree, nodeId: string): { success: boolean; tree: Tree } {
    const parentNode = TreeOperations.findParentNode(tree.root, nodeId);
    if (!parentNode) return { success: false, tree };

    const nodeIndex = parentNode.children.findIndex(child => child.id === nodeId);
    if (nodeIndex <= 0) return { success: false, tree }; // Can't indent first child

    const nodeToIndent = parentNode.children[nodeIndex];
    const previousSibling = parentNode.children[nodeIndex - 1];

    // Remove node from current position
    const newParentChildren = [...parentNode.children];
    newParentChildren.splice(nodeIndex, 1);

    // Add as child of previous sibling
    const newPreviousSibling = {
      ...previousSibling,
      children: [...previousSibling.children, nodeToIndent]
    };
    newParentChildren[nodeIndex - 1] = newPreviousSibling;

    // Update the tree
    const updatedTree = TreeOperations.transformTree(
      tree,
      (node) => node.id === parentNode.id,
      (node) => ({ ...node, children: newParentChildren })
    );

    return { success: true, tree: updatedTree };
  },

  /**
   * Outdent a node (move it up to parent's level)
   */
  outdentNode(tree: Tree, nodeId: string): { success: boolean; tree: Tree } {
    const parentNode = TreeOperations.findParentNode(tree.root, nodeId);
    if (!parentNode) return { success: false, tree };

    const grandParentNode = TreeOperations.findParentNode(tree.root, parentNode.id);
    if (!grandParentNode) return { success: false, tree }; // Already at root level

    const nodeIndex = parentNode.children.findIndex(child => child.id === nodeId);
    const parentIndex = grandParentNode.children.findIndex(child => child.id === parentNode.id);
    
    if (nodeIndex === -1 || parentIndex === -1) return { success: false, tree };

    const nodeToOutdent = parentNode.children[nodeIndex];

    // Remove from parent
    const newParentChildren = [...parentNode.children];
    newParentChildren.splice(nodeIndex, 1);

    // Add to grandparent after parent
    const newGrandParentChildren = [...grandParentNode.children];
    newGrandParentChildren.splice(parentIndex + 1, 0, nodeToOutdent);

    // Update the tree - we need a custom approach here since we're updating two levels
    const updateNode = (node: Node): Node => {
      if (node.id === parentNode.id) {
        return { ...node, children: newParentChildren };
      }
      if (node.id === grandParentNode.id) {
        return { ...node, children: newGrandParentChildren };
      }
      return {
        ...node,
        children: node.children.map(updateNode)
      };
    };

    return { success: true, tree: { ...tree, root: updateNode(tree.root) } };
  },

  /**
   * Convert Tree structure to markdown string
   */
  toMarkdown(tree: Tree): string {
    const renderNode = (node: Node, level: number = 0): string => {
      const block = tree.blocks.find(b => b.id === node.id);
      const content = block?.body || "";
      const indent = "  ".repeat(level);
      const line = `${indent}- ${content}`;
      
      const childLines = node.children.map(child => renderNode(child, level + 1)).join("\n");
      return childLines ? `${line}\n${childLines}` : line;
    };
    
    return tree.root.children.map(child => renderNode(child)).join("\n");
  },

  // Legacy conversion methods removed - no backward compatibility needed
};