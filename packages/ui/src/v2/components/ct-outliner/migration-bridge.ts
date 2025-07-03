import type { Tree, Node, Block, OutlineNode } from "./types.ts";
import { BlockOperations } from "./block-operations.ts";

/**
 * Migration bridge to help transition from legacy OutlineNode[] to new Tree structure
 * This allows the component to gradually migrate while maintaining compatibility
 */
export const MigrationBridge = {
  /**
   * Check if a value is a Tree structure
   */
  isTree(value: unknown): value is Tree {
    return (
      typeof value === "object" &&
      value !== null &&
      "root" in value &&
      "blocks" in value &&
      "attachments" in value
    );
  },

  /**
   * Check if a value is legacy OutlineNode array
   */
  isLegacyNodes(value: unknown): value is OutlineNode[] {
    return Array.isArray(value) && (value.length === 0 || (
      typeof value[0] === "object" &&
      value[0] !== null &&
      "content" in value[0] &&
      "level" in value[0]
    ));
  },

  /**
   * Normalize input to Tree structure
   * Handles both Tree input and legacy OutlineNode[] input
   */
  normalizeToTree(input: Tree | OutlineNode[] | unknown): Tree {
    if (MigrationBridge.isTree(input)) {
      return input;
    }
    
    if (MigrationBridge.isLegacyNodes(input)) {
      return BlockOperations.fromLegacyNodes(input);
    }

    // If input is neither, create empty tree
    return BlockOperations.createEmptyTree();
  },

  /**
   * Convert Tree back to legacy OutlineNode[] format
   * This maintains compatibility with existing component logic
   */
  treeToLegacyNodes(tree: Tree): OutlineNode[] {
    return BlockOperations.toLegacyNodes(tree);
  },

  /**
   * Convert legacy OutlineNode[] to Tree format
   */
  legacyNodesToTree(nodes: OutlineNode[]): Tree {
    return BlockOperations.fromLegacyNodes(nodes);
  },

  /**
   * Get a block's content by node ID
   */
  getNodeContent(tree: Tree, nodeId: string): string {
    const block = BlockOperations.findBlock(tree, nodeId);
    return block?.body || "";
  },

  /**
   * Update a block's content by node ID
   */
  updateNodeContent(tree: Tree, nodeId: string, content: string): Tree {
    return BlockOperations.updateBlock(tree, nodeId, content);
  },

  /**
   * Create a new node and block pair
   */
  createNodeAndBlock(content: string): { tree: Tree; nodeId: string } {
    const nodeId = BlockOperations.createId();
    const block = BlockOperations.createBlock({ id: nodeId, body: content });
    const node = BlockOperations.createNode({ id: nodeId });

    const tree: Tree = {
      root: node,
      blocks: [block],
      attachments: [],
    };

    return { tree, nodeId };
  },

  /**
   * Add a new node and block to an existing tree
   */
  addNodeAndBlock(tree: Tree, content: string, parentId?: string, index?: number): { tree: Tree; nodeId: string } {
    const nodeId = BlockOperations.createId();
    const block = BlockOperations.createBlock({ id: nodeId, body: content });
    const node = BlockOperations.createNode({ id: nodeId });

    // Add the block to the tree
    const updatedTree = BlockOperations.addBlock(tree, block);

    // Insert the node into the tree structure
    if (parentId !== undefined && index !== undefined) {
      return {
        tree: BlockOperations.insertNode(updatedTree, parentId, node, index),
        nodeId,
      };
    } else {
      // Add as a child of root if no parent specified
      const rootChildren = [...updatedTree.root.children, node];
      return {
        tree: {
          ...updatedTree,
          root: { ...updatedTree.root, children: rootChildren },
        },
        nodeId,
      };
    }
  },
};