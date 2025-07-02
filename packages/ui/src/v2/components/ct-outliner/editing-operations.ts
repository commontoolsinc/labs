import type { OutlineNode, EditingState } from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";

/**
 * Pure data transformation functions for editing operations
 */
export const EditingOperations = {
  /**
   * Apply edit completion to a node - pure data transformation
   */
  completeEdit(
    nodes: OutlineNode[], 
    nodeId: string, 
    newContent: string
  ): { updatedNodes: OutlineNode[]; success: boolean } {
    const node = TreeOperations.findNode(nodes, nodeId);
    if (!node) {
      return { updatedNodes: nodes, success: false };
    }

    // Update the node content directly
    node.content = newContent;
    
    return { updatedNodes: nodes, success: true };
  },

  /**
   * Prepare state for editing - pure data transformation
   */
  prepareEditingState(
    currentEditingNodeId: string | null,
    currentEditingContent: string,
    nodeId: string,
    nodeContent: string
  ): EditingState {
    return {
      editingNodeId: nodeId,
      editingContent: nodeContent,
      showingMentions: false,
    };
  },

  /**
   * Clear editing state - pure data transformation
   */
  clearEditingState(): EditingState {
    return {
      editingNodeId: null,
      editingContent: "",
      showingMentions: false,
    };
  }
};