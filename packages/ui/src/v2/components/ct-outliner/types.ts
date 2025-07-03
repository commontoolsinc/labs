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
 * Attachment to a block - for future extensibility
 */
export interface Attachment {
  name: string;
  charm: CharmReference;
}

/**
 * Block - the backing data for nodes, containing content and attachments
 */
export interface Block {
  readonly id: string;
  readonly body: string;
  readonly attachments: readonly Attachment[];
}

/**
 * Node - represents the tree structure, referencing blocks by ID
 */
export interface Node {
  readonly id: string;
  readonly children: readonly Node[];
}

/**
 * Complete tree structure with nodes and their backing blocks
 */
export interface Tree {
  readonly root: Node;
  readonly blocks: readonly Block[];
  readonly attachments: readonly Attachment[];
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

// Legacy types removed - using Tree/Node/Block structure exclusively

/**
 * Context object passed to keyboard commands
 */
export interface KeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: any; // Will be typed properly when we extract commands
  readonly allNodes: Node[];
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
 * Options for creating a new block
 */
export interface BlockCreationOptions {
  readonly body: string;
  readonly id?: string;
  readonly attachments?: readonly Attachment[];
}

/**
 * Options for creating a new node
 */
export interface NodeCreationOptions {
  readonly id?: string;
  readonly children?: readonly Node[];
}

// LegacyNodeCreationOptions removed