/**
 * Type definitions for the CT Outliner component
 */

import type { TreeOperationResult } from "./tree-diff.ts";

/**
 * Represents an item that can be mentioned using @ syntax
 */
export interface MentionableItem {
  name: string;
  charm: unknown;
}

/**
 * Attachment to a node - for future extensibility
 */
export type Attachment = unknown;

/**
 * Node - represents both the tree structure and content
 * Note: This is intentionally mutable for live tree manipulation
 */
export interface Node {
  body: string;
  children: Node[];
  attachments: Attachment[];
  [key: symbol]: any; // Allow [ID] property and other symbols
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
 * @deprecated Use PathBasedOutlinerOperations instead
 * Operations interface for outliner component
 *
 * @description Provides type-safe access to component methods for keyboard commands.
 * This interface defines all the methods that keyboard command handlers need to
 * interact with the outliner component without tight coupling.
 *
 * Uses CellController for reactive state management - tree operations automatically
 * trigger updates without manual emitChange() calls.
 */
export interface OutlinerOperations {
  readonly tree: Tree; // Access via cellController.getValue() - kept for backward compatibility
  focusedNode: Node | null; // Deprecated - use path-based approach internally
  collapsedNodes: Set<Node>; // Deprecated - use path-based approach internally

  // Tree operations - return void as CellController handles change propagation
  deleteNode(node: Node): void;
  indentNode(node: Node): void;
  outdentNode(node: Node): void;
  moveNodeUp(node: Node): void;
  moveNodeDown(node: Node): void;
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

  // Edit operations
  startEditing(node: Node): void;
  startEditingWithInitialText(node: Node, text: string): void;
  toggleEditMode(node: Node): void;
  finishEditing(): void;

  // Node creation
  createNewNodeAfter(node: Node): void;
  createChildNode(node: Node): void;

  // UI operations
  requestUpdate(): void;
  getAllVisibleNodes(): Node[];

  // Checkbox operations
  setNodeCheckbox(node: Node, isChecked: boolean): void;
  toggleNodeCheckbox(node: Node): void;

  // Legacy method - CellController handles change events automatically
  emitChange(): void;
}

/**
 * Path-based operations interface for outliner component
 *
 * @description Modern interface that uses paths instead of node references.
 * All operations return TreeOperationResult with diffs describing what changed.
 * This enables better state management and undo/redo functionality.
 */
export interface PathBasedOutlinerOperations {
  readonly tree: Tree;
  focusedNodePath: number[] | null;
  editingNodePath: number[] | null;
  collapsedNodePaths: Set<string>;

  // Tree operations - return TreeOperationResult with diffs
  deleteNodeByPath(path: number[]): Promise<TreeOperationResult>;
  indentNodeByPath(path: number[]): Promise<TreeOperationResult>;
  outdentNodeByPath(path: number[]): Promise<TreeOperationResult>;
  moveNodeUpByPath(path: number[]): Promise<TreeOperationResult>;
  moveNodeDownByPath(path: number[]): Promise<TreeOperationResult>;

  // Edit operations
  startEditingByPath(path: number[], initialContent?: string): void;
  finishEditing(): void;
  cancelEditing(): void;

  // Node creation
  createNodeAfterPath(
    path: number[],
    nodeData: { body: string },
  ): Promise<TreeOperationResult>;
  createChildNodeAtPath(
    path: number[],
    nodeData: { body: string },
  ): Promise<TreeOperationResult>;

  // UI operations
  requestUpdate(): void;
  getAllVisibleNodes(): Node[];
  getNodeByPath(path: number[]): Node | null;

  // Checkbox operations
  setNodeCheckboxByPath(path: number[], isChecked: boolean): void;
  toggleNodeCheckboxByPath(path: number[]): void;

  // State management
  applyTreeDiff(result: TreeOperationResult): void;
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
 * Path-based context object for keyboard commands
 */
export interface PathBasedKeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: PathBasedOutlinerOperations;
  readonly allNodes: Node[];
  readonly currentIndex: number;
  readonly focusedNodePath: number[] | null;
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
 * Path-based context for editing mode keyboard commands
 */
export interface PathBasedEditingKeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: PathBasedOutlinerOperations;
  readonly editingNodePath: number[];
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
 * Path-based command interface for keyboard actions
 */
export interface PathBasedKeyboardCommand {
  execute(context: PathBasedKeyboardContext): void;
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
 *
 * @deprecated With CellController, operations handle their own state management
 * and error propagation. This type is kept for backward compatibility only.
 */
export type OperationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

// LegacyNodeCreationOptions removed
