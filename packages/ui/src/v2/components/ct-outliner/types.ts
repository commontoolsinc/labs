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
 * Attachment to a node - for future extensibility
 */
export interface Attachment {
  name: string;
  charm: CharmReference;
}

/**
 * Node - represents both the tree structure and content
 */
export interface Node {
  readonly body: string;
  readonly children: readonly Node[];
  readonly attachments: readonly Attachment[];
}

/**
 * Complete tree structure
 */
export interface Tree {
  readonly root: Node;
}

/**
 * UI state separate from the core data structure
 */
export interface OutlineUIState {
  readonly collapsedNodes: ReadonlySet<Node>;
  readonly focusedNode: Node | null;
  readonly editingNode: Node | null;
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
  readonly focusedNode: Node | null;
}

/**
 * Context for editing mode keyboard commands
 */
export interface EditingKeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: any;
  readonly editingNode: Node;
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
  editingNode: Node | null;
  editingContent: string;
  showingMentions: boolean;
}

/**
 * Options for creating a new node
 */
export interface NodeCreationOptions {
  readonly body: string;
  readonly children?: readonly Node[];
  readonly attachments?: readonly Attachment[];
}

/**
 * Result type for operations that can succeed or fail
 */
export type OperationResult<T> = 
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

/**
 * Result type for tree update operations
 */
export type TreeUpdateResult = OperationResult<{
  readonly tree: Tree;
  readonly newFocusNode?: Node | null;
}>;

/**
 * Result type for tree movement operations
 */
export type TreeMoveResult = OperationResult<{
  readonly tree: Tree;
}>;

// LegacyNodeCreationOptions removed