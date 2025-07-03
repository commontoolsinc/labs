/**
 * Type definitions for the CT Outliner component
 */

/**
 * Represents a reference to a charm object with optional identifying properties
 */
export interface CharmReference {
  id?: string;
  _id?: string;
  charmId?: string;
  title?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Represents an item that can be mentioned using @ syntax
 */
export interface MentionableItem {
  name: string;
  charm: CharmReference;
}

/**
 * Core data structure for outline nodes, separate from UI state
 */
export interface OutlineNodeData {
  readonly id: string;
  readonly content: string;
  readonly children: readonly OutlineNodeData[];
  readonly level: number;
}

/**
 * UI state separate from the core data structure
 */
export interface OutlineUIState {
  readonly collapsedNodes: ReadonlySet<string>;
  readonly focusedNodeId: string | null;
  readonly editingNodeId: string | null;
  readonly editingContent: string;
  readonly showingMentions: boolean;
  readonly mentionQuery: string;
  readonly selectedMentionIndex: number;
}

/**
 * Working interface that combines data and UI state for compatibility
 * TODO: Eventually migrate to use OutlineNodeData + OutlineUIState separately
 */
export interface OutlineNode {
  id: string;
  content: string;
  children: OutlineNode[];
  collapsed: boolean;
  level: number;
}

/**
 * Result type for tree operations that may fail
 */
export interface TreeOperationResult<T = OutlineNode[]> {
  success: boolean;
  data: T;
}

/**
 * Context object passed to keyboard commands
 */
export interface KeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: any; // Will be typed properly when we extract commands
  readonly allNodes: OutlineNode[];
  readonly currentIndex: number;
  readonly focusedNodeId: string | null;
}

/**
 * Context for editing mode keyboard commands
 */
export interface EditingKeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: any;
  readonly editingNodeId: string;
  readonly editingContent: string;
  readonly textarea: HTMLTextAreaElement;
}

/**
 * Command interface for keyboard actions
 */
export interface KeyboardCommand {
  execute(context: KeyboardContext): void;
}

/**
 * Editing state for pure transformations
 */
export interface EditingState {
  editingNodeId: string | null;
  editingContent: string;
  showingMentions: boolean;
}

/**
 * Node creation options
 */
export interface NodeCreationOptions {
  content: string;
  level: number;
  id?: string;
}