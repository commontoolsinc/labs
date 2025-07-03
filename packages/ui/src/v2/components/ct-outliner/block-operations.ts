import type { 
  Tree, 
  Node, 
  Block, 
  Attachment, 
  BlockCreationOptions, 
  NodeCreationOptions 
} from "./types.ts";

/**
 * Pure functional operations for Block-based tree manipulation
 * 
 * This module handles the new data structure where:
 * - Nodes define the tree structure and reference blocks by ID
 * - Blocks contain the actual content and attachments
 * - The same block can appear multiple times in the tree (Roam-style block references)
 */
export const BlockOperations = {
  /**
   * Create a unique ID for nodes and blocks
   */
  createId(): string {
    return crypto.randomUUID();
  },

  /**
   * Create a new block with given options
   */
  createBlock(options: BlockCreationOptions): Block {
    return {
      id: options.id || BlockOperations.createId(),
      body: options.body,
      attachments: options.attachments || [],
    };
  },

  /**
   * Create a new node with given options
   */
  createNode(options: NodeCreationOptions): Node {
    return {
      id: options.id || BlockOperations.createId(),
      children: options.children || [],
    };
  },

  /**
   * Create an empty tree with a single root node and block
   */
  createEmptyTree(): Tree {
    const blockId = BlockOperations.createId();
    const rootBlock = BlockOperations.createBlock({ body: "", id: blockId });
    const rootNode = BlockOperations.createNode({ id: blockId });

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
      const found = BlockOperations.findNode(child, nodeId);
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
      const found = BlockOperations.findParentNode(child, targetId);
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
      result.push(...BlockOperations.getAllNodes(child));
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
    const updateNodeChildren = (node: Node): Node => {
      if (node.id === parentId) {
        const newChildren = [...node.children];
        newChildren.splice(index, 0, newNode);
        return { ...node, children: newChildren };
      }
      
      return {
        ...node,
        children: node.children.map(updateNodeChildren),
      };
    };

    return {
      ...tree,
      root: updateNodeChildren(tree.root),
    };
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
    const updateNode = (node: Node): Node => {
      const childIndex = node.children.findIndex(child => child.id === nodeId);
      
      if (childIndex > 0) {
        const newChildren = [...node.children];
        [newChildren[childIndex - 1], newChildren[childIndex]] = 
          [newChildren[childIndex], newChildren[childIndex - 1]];
        return { ...node, children: newChildren };
      }
      
      return {
        ...node,
        children: node.children.map(updateNode),
      };
    };

    const newTree = {
      ...tree,
      root: updateNode(tree.root),
    };
    
    const success = JSON.stringify(newTree) !== JSON.stringify(tree);
    return { success, tree: newTree };
  },

  /**
   * Move a node down among its siblings
   */
  moveNodeDown(tree: Tree, nodeId: string): { success: boolean; tree: Tree } {
    const updateNode = (node: Node): Node => {
      const childIndex = node.children.findIndex(child => child.id === nodeId);
      
      if (childIndex !== -1 && childIndex < node.children.length - 1) {
        const newChildren = [...node.children];
        [newChildren[childIndex], newChildren[childIndex + 1]] = 
          [newChildren[childIndex + 1], newChildren[childIndex]];
        return { ...node, children: newChildren };
      }
      
      return {
        ...node,
        children: node.children.map(updateNode),
      };
    };

    const newTree = {
      ...tree,
      root: updateNode(tree.root),
    };
    
    const success = JSON.stringify(newTree) !== JSON.stringify(tree);
    return { success, tree: newTree };
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
    const parentNode = BlockOperations.findParentNode(tree.root, nodeId);
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
    const allNodes = BlockOperations.getAllVisibleNodes(updatedTree.root, new Set());
    let newFocusId: string | null = null;
    
    if (allNodes.length > 0) {
      if (nodeIndex > 0 && parentNode.children[nodeIndex - 1]) {
        newFocusId = parentNode.children[nodeIndex - 1].id;
      } else if (parentNode.children[nodeIndex + 1]) {
        newFocusId = parentNode.children[nodeIndex + 1].id;
      } else {
        newFocusId = allNodes[0].id;
      }
    }

    return { success: true, tree: updatedTree, newFocusId };
  },

  /**
   * Indent a node (make it a child of the previous sibling)
   */
  indentNode(tree: Tree, nodeId: string): { success: boolean; tree: Tree } {
    const parentNode = BlockOperations.findParentNode(tree.root, nodeId);
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
    const updateNode = (node: Node): Node => {
      if (node.id === parentNode.id) {
        return { ...node, children: newParentChildren };
      }
      return {
        ...node,
        children: node.children.map(updateNode)
      };
    };

    return { success: true, tree: { ...tree, root: updateNode(tree.root) } };
  },

  /**
   * Outdent a node (move it up to parent's level)
   */
  outdentNode(tree: Tree, nodeId: string): { success: boolean; tree: Tree } {
    const parentNode = BlockOperations.findParentNode(tree.root, nodeId);
    if (!parentNode) return { success: false, tree };

    const grandParentNode = BlockOperations.findParentNode(tree.root, parentNode.id);
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

    // Update the tree
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

  /**
   * Convert legacy OutlineNode structure to new Tree structure
   */
  fromLegacyNodes(legacyNodes: Array<{id: string, content: string, children: any[], level: number}>): Tree {
    const blocks: Block[] = [];
    
    const convertNode = (legacyNode: any): Node => {
      // Create a block for this node's content
      const block = BlockOperations.createBlock({
        id: legacyNode.id,
        body: legacyNode.content,
      });
      blocks.push(block);
      
      // Convert children recursively
      const children = legacyNode.children.map(convertNode);
      
      return BlockOperations.createNode({
        id: legacyNode.id,
        children,
      });
    };

    // Handle root nodes - create a virtual root if there are multiple
    let root: Node;
    if (legacyNodes.length === 1) {
      root = convertNode(legacyNodes[0]);
    } else {
      // Create a virtual root node and block
      const rootId = BlockOperations.createId();
      const rootBlock = BlockOperations.createBlock({ id: rootId, body: "" });
      blocks.unshift(rootBlock);
      
      const children = legacyNodes.map(convertNode);
      root = BlockOperations.createNode({ id: rootId, children });
    }

    return {
      root,
      blocks,
      attachments: [],
    };
  },

  /**
   * Convert Tree structure to legacy OutlineNode structure for backward compatibility
   */
  toLegacyNodes(tree: Tree): Array<{id: string, content: string, children: any[], collapsed: boolean, level: number}> {
    const convertNode = (node: Node, level: number): any => {
      const block = BlockOperations.findBlock(tree, node.id);
      const content = block?.body || "";
      
      return {
        id: node.id,
        content,
        children: node.children.map(child => convertNode(child, level + 1)),
        collapsed: false, // Default to expanded
        level,
      };
    };

    // If root has content, return it as a single node
    const rootBlock = BlockOperations.findBlock(tree, tree.root.id);
    if (rootBlock?.body.trim()) {
      return [convertNode(tree.root, 0)];
    }
    
    // Otherwise return the root's children as top-level nodes
    return tree.root.children.map(child => convertNode(child, 0));
  },
};