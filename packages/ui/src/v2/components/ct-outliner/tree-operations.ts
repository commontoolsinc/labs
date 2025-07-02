import type { OutlineNode, TreeOperationResult, NodeCreationOptions } from "./types.ts";

/**
 * Pure functional operations for tree manipulation and traversal
 */
export const TreeOperations = {
  /**
   * Create a unique node ID
   */
  createNodeId(): string {
    return crypto.randomUUID();
  },

  /**
   * Create a new node with given options
   */
  createNode(options: NodeCreationOptions): OutlineNode {
    return {
      id: options.id || TreeOperations.createNodeId(),
      content: options.content,
      children: [],
      collapsed: false,
      level: options.level,
    };
  },

  /**
   * Find a node by ID in a tree structure
   */
  findNode(nodes: readonly OutlineNode[], id: string): OutlineNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = TreeOperations.findNode(node.children, id);
      if (found) return found;
    }
    return null;
  },

  /**
   * Find the parent array containing a node with the given ID
   */
  findNodeParent(
    nodes: readonly OutlineNode[], 
    id: string, 
    parent: readonly OutlineNode[] | null = null
  ): readonly OutlineNode[] | null {
    for (const node of nodes) {
      if (node.id === id) return parent;
      const found = TreeOperations.findNodeParent(node.children, id, node.children);
      if (found) return found;
    }
    return null;
  },

  /**
   * Find the parent node (not array) containing a child with the given ID
   */
  findParentNode(nodes: readonly OutlineNode[], id: string): OutlineNode | null {
    for (const node of nodes) {
      if (node.children.some(child => child.id === id)) {
        return node;
      }
      const found = TreeOperations.findParentNode(node.children, id);
      if (found) return found;
    }
    return null;
  },

  /**
   * Get the index of a node in its parent array
   */
  getNodeIndex(nodes: readonly OutlineNode[], id: string): number {
    return nodes.findIndex(node => node.id === id);
  },

  /**
   * Get all visible nodes (respecting collapsed state) in depth-first order
   */
  getAllVisibleNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
    const result: OutlineNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (!node.collapsed) {
        result.push(...TreeOperations.getAllVisibleNodes(node.children));
      }
    }
    return result;
  },

  /**
   * Update the level of a node and all its descendants
   */
  updateNodeLevels(node: OutlineNode): void {
    const updateChildren = (children: OutlineNode[], parentLevel: number) => {
      for (const child of children) {
        child.level = parentLevel + 1;
        updateChildren(child.children, child.level);
      }
    };
    updateChildren(node.children, node.level);
  },

  /**
   * Move a node up among its siblings
   */
  moveNodeUp(nodes: OutlineNode[], nodeId: string): boolean {
    const parentArray = TreeOperations.findNodeParent(nodes, nodeId) as OutlineNode[] || nodes;
    const currentIndex = TreeOperations.getNodeIndex(parentArray, nodeId);

    if (currentIndex <= 0) {
      return false; // Can't move up if first or not found
    }

    // Swap with previous sibling
    const node = parentArray[currentIndex];
    parentArray.splice(currentIndex, 1);
    parentArray.splice(currentIndex - 1, 0, node);

    return true;
  },

  /**
   * Move a node down among its siblings
   */
  moveNodeDown(nodes: OutlineNode[], nodeId: string): boolean {
    const parentArray = TreeOperations.findNodeParent(nodes, nodeId) as OutlineNode[] || nodes;
    const currentIndex = TreeOperations.getNodeIndex(parentArray, nodeId);

    if (currentIndex === -1 || currentIndex >= parentArray.length - 1) {
      return false; // Can't move down if last or not found
    }

    // Swap with next sibling  
    const node = parentArray[currentIndex];
    parentArray.splice(currentIndex, 1);
    parentArray.splice(currentIndex + 1, 0, node);

    return true;
  },

  /**
   * Indent a node (make it a child of its previous sibling)
   */
  indentNode(nodes: OutlineNode[], nodeId: string): boolean {
    const node = TreeOperations.findNode(nodes, nodeId);
    if (!node) return false;

    const parentArray = TreeOperations.findNodeParent(nodes, nodeId) as OutlineNode[] || nodes;
    const currentIndex = TreeOperations.getNodeIndex(parentArray, nodeId);

    if (currentIndex <= 0) {
      return false; // Cannot indent if first child or not found
    }

    // Get previous sibling
    const prevSibling = parentArray[currentIndex - 1];

    // Remove from current position and add as child of previous sibling
    parentArray.splice(currentIndex, 1);
    prevSibling.children.push(node);
    node.level = prevSibling.level + 1;
    prevSibling.collapsed = false;

    // Update levels of all descendants
    TreeOperations.updateNodeLevels(node);

    return true;
  },

  /**
   * Outdent a node (move it up one level in the hierarchy)
   */
  outdentNode(nodes: OutlineNode[], nodeId: string): boolean {
    const node = TreeOperations.findNode(nodes, nodeId);
    if (!node) return false;

    const parentNode = TreeOperations.findParentNode(nodes, nodeId);
    if (!parentNode) {
      return false; // Already at root level
    }

    const grandparentArray = TreeOperations.findNodeParent(nodes, parentNode.id) as OutlineNode[] || nodes;
    const parentIndex = TreeOperations.getNodeIndex(grandparentArray, parentNode.id);
    const nodeIndex = TreeOperations.getNodeIndex(parentNode.children, nodeId);

    // Remove from current parent
    parentNode.children.splice(nodeIndex, 1);

    // Insert after the parent in grandparent array
    grandparentArray.splice(parentIndex + 1, 0, node);

    // Update level
    node.level = parentNode.level;

    // Update levels of all descendants
    TreeOperations.updateNodeLevels(node);

    return true;
  },

  /**
   * Delete a node and handle children appropriately
   */
  deleteNode(nodes: OutlineNode[], nodeId: string): { success: boolean; newFocusId: string | null } {
    const parentArray = TreeOperations.findNodeParent(nodes, nodeId) as OutlineNode[] || nodes;
    const currentIndex = TreeOperations.getNodeIndex(parentArray, nodeId);

    if (currentIndex === -1) {
      return { success: false, newFocusId: null };
    }

    // Don't delete if it's the only root node
    if (nodes.length === 1 && nodes[0].id === nodeId && nodes[0].children.length === 0) {
      return { success: false, newFocusId: null };
    }

    const nodeToDelete = parentArray[currentIndex];
    const allVisibleNodes = TreeOperations.getAllVisibleNodes(nodes);
    const deletedNodeIndex = allVisibleNodes.findIndex(n => n.id === nodeId);

    // Move children up to parent level if any
    if (nodeToDelete.children.length > 0) {
      const adjustedChildren = nodeToDelete.children.map((child) => ({
        ...child,
        level: nodeToDelete.level,
      }));
      // Update levels of all descendants
      adjustedChildren.forEach(child => TreeOperations.updateNodeLevels(child));
      parentArray.splice(currentIndex, 1, ...adjustedChildren);
    } else {
      parentArray.splice(currentIndex, 1);
    }

    // Determine new focus
    let newFocusId: string | null = null;
    const updatedVisibleNodes = TreeOperations.getAllVisibleNodes(nodes);
    
    if (updatedVisibleNodes.length === 0) {
      // Will need to create a new node
      newFocusId = null;
    } else if (deletedNodeIndex > 0 && deletedNodeIndex - 1 < updatedVisibleNodes.length) {
      newFocusId = updatedVisibleNodes[deletedNodeIndex - 1].id;
    } else if (updatedVisibleNodes.length > 0) {
      newFocusId = updatedVisibleNodes[0].id;
    }

    return { success: true, newFocusId };
  }
};