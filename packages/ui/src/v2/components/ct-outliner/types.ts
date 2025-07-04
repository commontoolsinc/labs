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
 * Note: This is intentionally mutable for live tree manipulation
 */
export interface Node {
  body: string;
  children: Node[];
  attachments: Attachment[];
}

/**
 * Mutable type variant of Node for safe mutations in tree operations
 *
 * @description This eliminates the need for 'any' casting while preserving type safety.
 * Used internally by tree operations that need to mutate node properties directly.
 * The type removes readonly modifiers from all properties to allow in-place mutations.
 */
export type MutableNode = {
  -readonly [K in keyof Node]: Node[K] extends readonly unknown[]
    ? Node[K][number][]
    : Node[K];
};

/**
 * Complete tree structure
 * Note: This is intentionally mutable for live tree manipulation
 */
export interface Tree {
  root: Node;
}

/**
 * Mutable type variant of Tree for safe mutations in tree operations
 */
export type MutableTree = {
  -readonly [K in keyof Tree]: Tree[K] extends Node ? MutableNode : Tree[K];
};

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
 * Operations interface for outliner component
 *
 * @description Provides type-safe access to component methods for keyboard commands.
 * This interface defines all the methods that keyboard command handlers need to
 * interact with the outliner component without tight coupling.
 */
export interface OutlinerOperations {
  readonly value: Tree;
  focusedNode: Node | null;
  collapsedNodes: Set<Node>;

  deleteNode(node: Node): void;
  indentNode(node: Node): void;
  outdentNode(node: Node): void;
  indentNodeWithEditState(
    node: Node,
    editingContent: string,
    cursorPosition: number,
  ): void;
  outdentNodeWithEditState(
    node: Node,
    editingContent: string,
    cursorPosition: number,
  ): void;
  startEditing(node: Node): void;
  startEditingWithInitialText(node: Node, text: string): void;
  toggleEditMode(node: Node): void;
  finishEditing(): void;
  createNewNodeAfter(node: Node): void;
  createChildNode(node: Node): void;
  requestUpdate(): void;
  emitChange(): void;
  getAllVisibleNodes(): Node[];
}

/**
 * Context object passed to keyboard commands
 */
export interface KeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: OutlinerOperations;
  readonly allNodes: Node[];
  readonly currentIndex: number;
  readonly focusedNode: Node | null;
}

/**
 * Context for editing mode keyboard commands
 */
export interface EditingKeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: OutlinerOperations;
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
  body: string;
  children?: Node[];
  attachments?: Attachment[];
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

/**
 * Result type for node deletion operations
 */
export type NodeDeletionResult = OperationResult<{
  readonly tree: Tree;
  readonly newFocusNode: Node | null;
}>;

/**
 * Result type for tree structure operations (indent/outdent)
 */
export type TreeStructureResult = OperationResult<{
  readonly tree: Tree;
}>;

// LegacyNodeCreationOptions removed
