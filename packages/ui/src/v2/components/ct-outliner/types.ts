/**
 * Type definitions for the CT Outliner component
 *
 * This file contains the core types for the CT Outliner, including support for both
 * direct Tree operations and Cell<Tree> reactive operations during the migration period.
 */

/**
 * Import Cell interface from @commontools/runner for reactive state management
 * 
 * The Cell interface provides reactive container capabilities with methods like:
 * - get(): T - Gets current value
 * - set(value: T): void - Sets entire value  
 * - update(values: Partial<T>): void - Updates partial values
 * - key(valueKey: K): Cell<T[K]> - Gets cell for specific property
 * - sink(callback: (value: T) => void): Cancel - Subscribes to changes
 */
import type { Cell } from "./simple-cell.ts";

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
 * Cell-based helper types for reactive tree operations
 *
 * These types provide Cell<T> wrappers around core tree structures to enable
 * reactive state management during the migration from direct Tree mutation to
 * Cell<Tree> operations.
 */

/**
 * A Cell containing a complete Tree structure
 *
 * Provides reactive access to the entire tree with methods like:
 * - get(): Tree - Gets current tree state
 * - set(tree: Tree): void - Sets entire tree
 * - update(partial: Partial<Tree>): void - Updates tree properties
 * - key('root'): NodeCell - Gets reactive access to root node
 * - sink(callback): Cancel - Subscribes to tree changes
 */
export type TreeCell = Cell<Tree>;

/**
 * A Cell containing a Node structure
 *
 * Provides reactive access to individual nodes with methods like:
 * - get(): Node - Gets current node state
 * - set(node: Node): void - Sets entire node
 * - update(partial: Partial<Node>): void - Updates node properties
 * - key('body'): Cell<string> - Gets reactive access to node body
 * - key('children'): NodeArrayCell - Gets reactive access to children array
 * - key('attachments'): Cell<Attachment[]> - Gets reactive access to attachments
 * - sink(callback): Cancel - Subscribes to node changes
 */
export type NodeCell = Cell<Node>;

/**
 * A Cell containing an array of Node structures
 *
 * Provides reactive access to node arrays (like children) with methods like:
 * - get(): Node[] - Gets current array state
 * - set(nodes: Node[]): void - Sets entire array
 * - push(node: Node): void - Adds node to end of array
 * - key(index): NodeCell - Gets reactive access to specific child node
 * - sink(callback): Cancel - Subscribes to array changes
 */
export type NodeArrayCell = Cell<Node[]>;

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
 *
 * During the migration period, this interface supports both direct Tree operations
 * and Cell<Tree> reactive operations to maintain backward compatibility.
 */
export interface OutlinerOperations {
  // Cell-based tree access (current implementation)
  readonly value: Cell<Tree>;
  focusedNode: Node | null;
  collapsedNodes: Set<Node>;

  // Cell-based reactive access (new approach - optional during migration)
  /**
   * Reactive access to the tree structure
   *
   * Provides Cell<Tree> interface for reactive tree operations:
   * - treeCell.get(): Tree - Gets current tree state
   * - treeCell.set(tree: Tree): void - Sets entire tree
   * - treeCell.key('root'): NodeCell - Gets reactive root node
   * - treeCell.sink(callback): Cancel - Subscribes to tree changes
   */
  readonly treeCell?: TreeCell;

  /**
   * Reactive access to the root node
   *
   * Provides Cell<Node> interface for reactive root node operations:
   * - rootCell.get(): Node - Gets current root node
   * - rootCell.set(node: Node): void - Sets entire root node
   * - rootCell.key('children'): NodeArrayCell - Gets reactive children array
   * - rootCell.sink(callback): Cancel - Subscribes to root node changes
   */
  readonly rootCell?: NodeCell;

  /**
   * Reactive access to the focused node
   *
   * Provides Cell<Node | null> interface for reactive focus management:
   * - focusCell.get(): Node | null - Gets current focused node
   * - focusCell.set(node: Node | null): void - Sets focused node
   * - focusCell.sink(callback): Cancel - Subscribes to focus changes
   */
  readonly focusCell?: Cell<Node | null>;

  /**
   * Reactive access to the collapsed nodes set
   *
   * Provides Cell<Set<Node>> interface for reactive collapse state:
   * - collapsedCell.get(): Set<Node> - Gets current collapsed nodes
   * - collapsedCell.set(nodes: Set<Node>): void - Sets collapsed nodes
   * - collapsedCell.sink(callback): Cancel - Subscribes to collapse changes
   */
  readonly collapsedCell?: Cell<Set<Node>>;

  // Direct tree operations (maintained for backward compatibility)
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

  // Cell-based operations (new approach - optional during migration)
  /**
   * Deletes a node using reactive operations
   *
   * @param nodeCell - The reactive node cell to delete
   */
  deleteNodeCell?(nodeCell: NodeCell): void;

  /**
   * Indents a node using reactive operations
   *
   * @param nodeCell - The reactive node cell to indent
   */
  indentNodeCell?(nodeCell: NodeCell): void;

  /**
   * Outdents a node using reactive operations
   *
   * @param nodeCell - The reactive node cell to outdent
   */
  outdentNodeCell?(nodeCell: NodeCell): void;

  /**
   * Creates a new node after the specified node using reactive operations
   *
   * @param nodeCell - The reactive node cell to create after
   * @returns The new node cell
   */
  createNewNodeAfterCell?(nodeCell: NodeCell): NodeCell;

  /**
   * Creates a child node using reactive operations
   *
   * @param parentCell - The reactive parent node cell
   * @returns The new child node cell
   */
  createChildNodeCell?(parentCell: NodeCell): NodeCell;
}

/**
 * Extended operations interface for components using Cell<Tree>
 * 
 * This interface represents the current state of the CTOutliner component
 * which uses Cell<Tree> for the value property but still accesses it directly.
 * This will be used during the migration to track the actual component interface.
 */
export interface CellBasedOutlinerOperations extends Omit<OutlinerOperations, 'value'> {
  // Cell-based tree access (current component implementation)
  readonly value: Cell<Tree>;
}

/**
 * Context object passed to keyboard commands
 *
 * Enhanced during migration to provide both direct access and Cell-based reactive access
 * to outliner state for keyboard command handlers.
 */
export interface KeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: OutlinerOperations;
  readonly allNodes: Node[];
  readonly currentIndex: number;
  readonly focusedNode: Node | null;

  // Cell-based reactive access (new approach - optional during migration)
  /**
   * Reactive access to the tree structure for keyboard commands
   *
   * Enables keyboard commands to reactively interact with the tree:
   * - treeCell.get(): Tree - Gets current tree for read operations
   * - treeCell.key('root'): NodeCell - Gets reactive root for modifications
   * - treeCell.sink(callback): Cancel - Subscribes to tree changes
   */
  readonly treeCell?: TreeCell;

  /**
   * Reactive access to the currently focused node
   *
   * Enables keyboard commands to reactively manage focus:
   * - focusedNodeCell.get(): Node | null - Gets current focused node
   * - focusedNodeCell.set(node: Node | null): void - Sets focused node
   * - focusedNodeCell.sink(callback): Cancel - Subscribes to focus changes
   */
  readonly focusedNodeCell?: Cell<Node | null>;

  /**
   * Reactive access to all visible nodes
   *
   * Enables keyboard commands to reactively access the node list:
   * - allNodesCell.get(): Node[] - Gets current visible nodes
   * - allNodesCell.sink(callback): Cancel - Subscribes to node list changes
   */
  readonly allNodesCell?: Cell<Node[]>;
}

/**
 * Cell-based keyboard context for components using Cell<Tree>
 * 
 * This interface represents the context for components that use Cell<Tree>
 * but still access it directly during the migration period.
 */
export interface CellBasedKeyboardContext extends Omit<KeyboardContext, 'component'> {
  readonly component: CellBasedOutlinerOperations;
}

/**
 * Context for editing mode keyboard commands
 *
 * Enhanced during migration to provide both direct access and Cell-based reactive access
 * to editing state for keyboard command handlers.
 */
export interface EditingKeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: OutlinerOperations;
  readonly editingNode: Node;
  readonly editingContent: string;
  readonly textarea: HTMLTextAreaElement;

  // Cell-based reactive access (new approach - optional during migration)
  /**
   * Reactive access to the currently editing node
   *
   * Enables editing commands to reactively interact with the node being edited:
   * - editingNodeCell.get(): Node - Gets current editing node
   * - editingNodeCell.set(node: Node): void - Sets editing node
   * - editingNodeCell.key('body'): Cell<string> - Gets reactive access to body
   * - editingNodeCell.sink(callback): Cancel - Subscribes to editing node changes
   */
  readonly editingNodeCell?: NodeCell;

  /**
   * Reactive access to the editing content
   *
   * Enables editing commands to reactively manage content:
   * - editingContentCell.get(): string - Gets current editing content
   * - editingContentCell.set(content: string): void - Sets editing content
   * - editingContentCell.sink(callback): Cancel - Subscribes to content changes
   */
  readonly editingContentCell?: Cell<string>;

  /**
   * Reactive access to the tree structure during editing
   *
   * Enables editing commands to reactively modify the tree:
   * - treeCell.get(): Tree - Gets current tree state
   * - treeCell.key('root'): NodeCell - Gets reactive root node
   * - treeCell.sink(callback): Cancel - Subscribes to tree changes
   */
  readonly treeCell?: TreeCell;
}

/**
 * Cell-based editing keyboard context for components using Cell<Tree>
 * 
 * This interface represents the editing context for components that use Cell<Tree>
 * but still access it directly during the migration period.
 */
export interface CellBasedEditingKeyboardContext extends Omit<EditingKeyboardContext, 'component'> {
  readonly component: CellBasedOutlinerOperations;
}

/**
 * Command interface for keyboard actions
 */
export interface KeyboardCommand {
  execute(context: KeyboardContext): void;
}

/**
 * Editing state for pure transformations
 *
 * Enhanced during migration to support both direct state access and Cell-based reactive access.
 */
export interface EditingState {
  editingNode: Node | null;
  editingContent: string;
  showingMentions: boolean;
}

/**
 * Cell-based editing state for reactive transformations
 *
 * Provides reactive access to editing state using Cell<T> interfaces:
 * - editingNodeCell.get(): Node | null - Gets current editing node
 * - editingContentCell.get(): string - Gets current editing content
 * - showingMentionsCell.get(): boolean - Gets current mentions visibility
 */
export interface EditingStateCell {
  /** Reactive access to the currently editing node */
  readonly editingNodeCell: Cell<Node | null>;

  /** Reactive access to the editing content */
  readonly editingContentCell: Cell<string>;

  /** Reactive access to the mentions visibility state */
  readonly showingMentionsCell: Cell<boolean>;
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
 * Cell-based operation result type
 *
 * Provides reactive access to operation results using Cell<T> interface:
 * - resultCell.get(): OperationResult<T> - Gets current operation result
 * - resultCell.sink(callback): Cancel - Subscribes to result changes
 */
export type OperationResultCell<T> = Cell<OperationResult<T>>;

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

/**
 * Cell-based result types for reactive operations
 *
 * These types provide Cell<T> wrappers around operation results to enable
 * reactive handling of tree operations during the migration period.
 */

/**
 * Cell-based result type for tree update operations
 *
 * Provides reactive access to tree update results:
 * - updateResultCell.get(): TreeUpdateResult - Gets current update result
 * - updateResultCell.sink(callback): Cancel - Subscribes to update result changes
 */
export type TreeUpdateResultCell = OperationResultCell<{
  readonly tree: Tree;
  readonly newFocusNode?: Node | null;
}>;

/**
 * Cell-based result type for tree movement operations
 *
 * Provides reactive access to tree movement results:
 * - moveResultCell.get(): TreeMoveResult - Gets current move result
 * - moveResultCell.sink(callback): Cancel - Subscribes to move result changes
 */
export type TreeMoveResultCell = OperationResultCell<{
  readonly tree: Tree;
}>;

/**
 * Cell-based result type for node deletion operations
 *
 * Provides reactive access to node deletion results:
 * - deleteResultCell.get(): NodeDeletionResult - Gets current deletion result
 * - deleteResultCell.sink(callback): Cancel - Subscribes to deletion result changes
 */
export type NodeDeletionResultCell = OperationResultCell<{
  readonly tree: Tree;
  readonly newFocusNode: Node | null;
}>;

/**
 * Cell-based result type for tree structure operations (indent/outdent)
 *
 * Provides reactive access to tree structure operation results:
 * - structureResultCell.get(): TreeStructureResult - Gets current structure result
 * - structureResultCell.sink(callback): Cancel - Subscribes to structure result changes
 */
export type TreeStructureResultCell = OperationResultCell<{
  readonly tree: Tree;
}>;
