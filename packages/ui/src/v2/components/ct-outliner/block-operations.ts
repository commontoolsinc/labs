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
  moveNodeUp(tree: Tree, nodeId: string): Tree {
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

    return {
      ...tree,
      root: updateNode(tree.root),
    };
  },

  /**
   * Move a node down among its siblings
   */
  moveNodeDown(tree: Tree, nodeId: string): Tree {
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

    return {
      ...tree,
      root: updateNode(tree.root),
    };
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