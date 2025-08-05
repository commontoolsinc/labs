import { css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { BaseElement } from "../../core/base-element.ts";
import { marked } from "marked";
import { type Cell, getEntityId, isCell, NAME } from "@commontools/runner";

/**
 * Executes a mutation on a Cell within a transaction
 * @param cell - The Cell to mutate
 * @param mutator - Function that performs the mutation
 */
async function mutateCell<T>(
  cell: Cell<T>,
  mutator: (cell: Cell<T>) => void,
): Promise<void> {
  const tx = cell.runtime.edit();
  mutator(cell.withTx(tx));
  await tx.commit();
}

import type {
  EditingKeyboardContext,
  EditingState,
  KeyboardContext,
  MentionableItem,
  Node as OutlineTreeNode,
  Tree,
  PathBasedOutlinerOperations,
} from "./types.ts";
import { TreeDiffCalculator, PathDiffApplier, type TreeOperationResult } from "./tree-diff.ts";
import {
  executeEditingKeyboardCommand,
  executeKeyboardCommand,
  executePathBasedKeyboardCommand,
} from "./keyboard-commands.ts";
import { TreeOperations } from "./tree-operations.ts";
import { NodeUtils } from "./node-utils.ts";
import { EventUtils } from "./event-utils.ts";
import {
  pathToString,
  stringToPath,
  getNodeByPath,
  getNodePath,
  getNodeCell,
  getNodeBodyCell,
  getNodeBodyCellByPath,
  getNodeChildrenCell,
  getNodeCellByPath,
} from "./node-path.ts";
import { Charm, charmSchema, getRecipeIdFromCharm } from "@commontools/charm";
import "../ct-render/ct-render.ts";

/**
 * CTOutliner - An outliner component with hierarchical tree structure
 *
 * Works directly with Cell<Tree> values for reactive state management.
 * Operations automatically propagate changes through the Cell system.
 *
 * @element ct-outliner
 *
 * @attr {Cell<Tree>} value - Tree structure Cell containing root node and children
 * @attr {boolean} readonly - Whether the outliner is read-only
 * @attr {Array} mentionable - Array of mentionable items with {name, charm} structure
 *
 * @fires ct-change - Fired when content changes with detail: { value }
 * @fires charm-link-click - Fired when a charm link is clicked with detail: { href, text, charm }
 *
 * @example
 * // With Cell<Tree> for reactive updates
 * const treeCell = runtime.getCell<Tree>({ type: "tree" });
 * <ct-outliner .value=${treeCell}></ct-outliner>
 */

export const OutlinerEffects = {
  /**
   * Focus the outliner element for keyboard navigation
   */
  focusOutliner(shadowRoot: ShadowRoot | null): void {
    if (!shadowRoot) return;

    setTimeout(() => {
      const outliner = shadowRoot.querySelector(".outliner") as HTMLElement;
      outliner?.focus();
    }, 0);
  },

  /**
   * Focus and select text in an editor
   */
  focusEditor(shadowRoot: ShadowRoot | null, nodeIndex: number): void {
    if (!shadowRoot) return;

    setTimeout(() => {
      const editor = shadowRoot.querySelector(
        `#editor-${nodeIndex}`,
      ) as HTMLTextAreaElement;
      if (editor) {
        editor.focus();
        editor.select();
      }
    }, 0);
  },

  /**
   * Set cursor position in an editor
   */
  setCursorPosition(
    shadowRoot: ShadowRoot | null,
    nodeIndex: number,
    position: number,
  ): void {
    if (!shadowRoot) return;

    setTimeout(() => {
      const editor = shadowRoot.querySelector(
        `#editor-${nodeIndex}`,
      ) as HTMLTextAreaElement;
      if (editor) {
        editor.setSelectionRange(position, position);
        editor.focus();
      }
    }, 0);
  },
};

export class CTOutliner extends BaseElement implements PathBasedOutlinerOperations {
  static override properties = {
    value: { type: Object },
    readonly: { type: Boolean },
    mentionable: { type: Array },
    tree: { type: Object, state: true },
    _collapsedNodePaths: { type: Object, state: true },
    focusedNodePath: { type: Array, state: true },
    showingMentions: { type: Boolean, state: true },
    mentionQuery: { type: String, state: true },
    selectedMentionIndex: { type: Number, state: true },
  };

  declare value: Cell<Tree> | null;
  declare readonly: boolean;
  declare mentionable: Cell<Charm[]>;

  // Direct tree access from Cell
  get tree(): Tree {
    if (!this.value) {
      return TreeOperations.createEmptyTree();
    }
    return this.value.getAsQueryResult();
  }
  private _collapsedNodePaths: Set<string> = new Set(); // Set of node paths as strings
  declare focusedNodePath: number[] | null;
  declare showingMentions: boolean;

  // Path-based state management only
  get collapsedNodePaths(): Set<string> {
    return this._collapsedNodePaths;
  }

  set collapsedNodePaths(paths: Set<string>) {
    this._collapsedNodePaths = new Set(paths);
  }

  // Compatibility properties for OutlinerOperations interface
  get focusedNode(): OutlineTreeNode | null {
    return this.focusedNodePath ? getNodeByPath(this.tree, this.focusedNodePath) : null;
  }

  set focusedNode(node: OutlineTreeNode | null) {
    this.focusedNodePath = node ? getNodePath(this.tree, node) : null;
  }

  get collapsedNodes(): Set<OutlineTreeNode> {
    const nodes = new Set<OutlineTreeNode>();
    for (const pathStr of this.collapsedNodePaths) {
      const path = stringToPath(pathStr);
      const node = getNodeByPath(this.tree, path);
      if (node) {
        nodes.add(node);
      }
    }
    return nodes;
  }

  set collapsedNodes(nodes: Set<OutlineTreeNode>) {
    const paths = new Set<string>();
    for (const node of nodes) {
      const path = getNodePath(this.tree, node);
      if (path) {
        paths.add(pathToString(path));
      }
    }
    this.collapsedNodePaths = paths;
  }

  // PathBasedOutlinerOperations implementation
  getNodeByPath(path: number[]): OutlineTreeNode | null {
    return getNodeByPath(this.tree, path);
  }

  async deleteNodeByPath(path: number[]): Promise<TreeOperationResult> {
    if (!this.value) {
      return {
        changes: [],
        newFocusedPath: null,
        success: false,
        error: "No tree value available",
      };
    }

    const result = TreeDiffCalculator.calculateDeleteDiff(path, this.tree);
    if (!result.success) {
      return result;
    }

    // Apply the delete operation using existing Cell operations
    const nodeCell = getNodeCellByPath(this.value, path) as Cell<OutlineTreeNode>;
    if (nodeCell) {
      const newFocusPath = await TreeOperations.deleteNodeCell(
        this.value.key("root"),
        nodeCell,
        path
      );
      result.newFocusedPath = newFocusPath;
    }

    this.applyTreeDiff(result);
    return result;
  }

  async indentNodeByPath(path: number[]): Promise<TreeOperationResult> {
    if (!this.value) {
      return {
        changes: [],
        newFocusedPath: null,
        success: false,
        error: "No tree value available",
      };
    }

    const result = TreeDiffCalculator.calculateIndentDiff(path, this.tree);
    if (!result.success) {
      return result;
    }

    // Apply the indent operation using existing Cell operations
    const newFocusPath = await TreeOperations.indentNodeCell(
      this.value.key("root"),
      path
    );
    if (newFocusPath) {
      result.newFocusedPath = newFocusPath;
    }

    this.applyTreeDiff(result);
    return result;
  }

  async outdentNodeByPath(path: number[]): Promise<TreeOperationResult> {
    if (!this.value) {
      return {
        changes: [],
        newFocusedPath: null,
        success: false,
        error: "No tree value available",
      };
    }

    const result = TreeDiffCalculator.calculateOutdentDiff(path, this.tree);
    if (!result.success) {
      return result;
    }

    // Apply the outdent operation using existing Cell operations
    const newFocusPath = await TreeOperations.outdentNodeCell(
      this.value.key("root"),
      path
    );
    if (newFocusPath) {
      result.newFocusedPath = newFocusPath;
    }

    this.applyTreeDiff(result);
    return result;
  }

  async moveNodeUpByPath(path: number[]): Promise<TreeOperationResult> {
    if (!this.value) {
      return {
        changes: [],
        newFocusedPath: null,
        success: false,
        error: "No tree value available",
      };
    }

    const result = TreeDiffCalculator.calculateMoveUpDiff(path, this.tree);
    if (!result.success) {
      return result;
    }

    // Apply the move operation using existing Cell operations
    const nodeCell = getNodeCellByPath(this.value, path) as Cell<OutlineTreeNode>;
    if (nodeCell) {
      const success = await TreeOperations.moveNodeUpCell(
        this.value.key("root"),
        nodeCell,
        path
      );
      if (success && result.newFocusedPath) {
        this.applyTreeDiff(result);
      }
    }

    return result;
  }

  async moveNodeDownByPath(path: number[]): Promise<TreeOperationResult> {
    if (!this.value) {
      return {
        changes: [],
        newFocusedPath: null,
        success: false,
        error: "No tree value available",
      };
    }

    const result = TreeDiffCalculator.calculateMoveDownDiff(path, this.tree);
    if (!result.success) {
      return result;
    }

    // Apply the move operation using existing Cell operations
    const nodeCell = getNodeCellByPath(this.value, path) as Cell<OutlineTreeNode>;
    if (nodeCell) {
      const success = await TreeOperations.moveNodeDownCell(
        this.value.key("root"),
        nodeCell,
        path
      );
      if (success && result.newFocusedPath) {
        this.applyTreeDiff(result);
      }
    }

    return result;
  }

  async createNodeAfterPath(path: number[], nodeData: { body: string }): Promise<TreeOperationResult> {
    if (!this.value) {
      return {
        changes: [],
        newFocusedPath: null,
        success: false,
        error: "No tree value available",
      };
    }

    const result = TreeDiffCalculator.calculateCreateAfterDiff(path, nodeData, this.tree);
    if (!result.success) {
      return result;
    }

    // Apply the create operation using existing Cell operations
    const nodeCell = getNodeCellByPath(this.value, path) as Cell<OutlineTreeNode>;
    if (nodeCell) {
      await this.createNewNodeAfterCell(nodeCell);
    }

    this.applyTreeDiff(result);
    return result;
  }

  async createChildNodeAtPath(path: number[], nodeData: { body: string }): Promise<TreeOperationResult> {
    if (!this.value) {
      return {
        changes: [],
        newFocusedPath: null,
        success: false,
        error: "No tree value available",
      };
    }

    const result = TreeDiffCalculator.calculateCreateChildDiff(path, nodeData, this.tree);
    if (!result.success) {
      return result;
    }

    // Apply the create operation using existing Cell operations
    if (!this.value) return result;

    const newNode = TreeOperations.createNode({ body: nodeData.body });
    const newNodePath = [...path, 0]; // Insert as first child

    const node = getNodeByPath(this.tree, path);
    if (!node) return result;
    
    const nodeChildrenCell = getNodeChildrenCell(this.value, this.tree, node);
    if (nodeChildrenCell) {
      await mutateCell(nodeChildrenCell, (cell) => {
        const currentChildren = cell.get();
        const newChildren = [newNode, ...currentChildren];
        cell.set(newChildren);
      });
    }

    this.applyTreeDiff(result);
    return result;
  }

  startEditingByPath(path: number[], initialContent?: string): void {
    if (this.readonly) return;

    this.editingNodePath = path;
    const node = getNodeByPath(this.tree, path);
    this.editingContent = initialContent ?? (node?.body || "");
    this.requestUpdate();

    // Focus the editor
    if (node) {
      const nodeIndex = this.getNodeIndex(node);
      OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
    }
  }

  cancelEditing(): void {
    if (!this.editingNodePath) return;

    this.focusedNodePath = this.editingNodePath;
    this.editingNodePath = null;
    this.editingContent = "";
    this.requestUpdate();
    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  /**
   * Start editing a node (compatibility method for tests)
   * @param node - The node to start editing
   */
  startEditing(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.startEditingByPath(path, node.body);
    }
  }

  // Compatibility methods for OutlinerOperations interface
  deleteNode(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.deleteNodeByPath(path);
    }
  }

  indentNode(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.indentNodeByPath(path);
    }
  }

  outdentNode(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.outdentNodeByPath(path);
    }
  }

  moveNodeUp(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.moveNodeUpByPath(path);
    }
  }

  moveNodeDown(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.moveNodeDownByPath(path);
    }
  }

  indentNodeWithEditState(node: OutlineTreeNode, editingContent: string, cursorPosition: number): void {
    // For compatibility - finish editing first, then indent
    if (this.editingNodePath) {
      this.finishEditing();
    }
    this.indentNode(node);
  }

  outdentNodeWithEditState(node: OutlineTreeNode, editingContent: string, cursorPosition: number): void {
    // For compatibility - finish editing first, then outdent
    if (this.editingNodePath) {
      this.finishEditing();
    }
    this.outdentNode(node);
  }

  startEditingWithInitialText(node: OutlineTreeNode, text: string): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.startEditingWithInitialTextByPath(path, text);
    }
  }

  toggleEditMode(node: OutlineTreeNode): void {
    if (this.editingNodePath) {
      this.finishEditing();
    } else {
      this.startEditing(node);
    }
  }

  createNewNodeAfter(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.createNodeAfterPath(path, { body: "" });
    }
  }

  createChildNode(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.createChildNodeAtPath(path, { body: "" });
    }
  }

  setNodeCheckbox(node: OutlineTreeNode, isChecked: boolean): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.setNodeCheckboxByPath(path, isChecked);
    }
  }

  toggleNodeCheckbox(node: OutlineTreeNode): void {
    const path = getNodePath(this.tree, node);
    if (path) {
      this.toggleNodeCheckboxByPath(path);
    }
  }

  setNodeCheckboxByPath(path: number[], isChecked: boolean): void {
    if (!this.value) return;

    const nodeBodyCell = getNodeBodyCellByPath(this.value, path);
    if (nodeBodyCell) {
      mutateCell(nodeBodyCell, (cell) => {
        const currentBody = cell.get();

        // Set checkbox to the specified state
        let newBody: string;
        const hasCheckbox = /^\s*\[[ x]?\]\s*/.test(currentBody);

        if (hasCheckbox) {
          // Update existing checkbox
          if (isChecked) {
            // Set to checked
            newBody = currentBody.replace(/^\s*\[[ x]?\]\s*/, "[x] ");
          } else {
            // Set to unchecked (normalize to [ ])
            newBody = currentBody.replace(/^\s*\[[ x]?\]\s*/, "[ ] ");
          }
        } else {
          // Add checkbox if none exists
          if (isChecked) {
            newBody = "[x] " + currentBody;
          } else {
            newBody = "[ ] " + currentBody;
          }
        }

        cell.set(newBody);
      });
    }

    this.requestUpdate();
  }

  toggleNodeCheckboxByPath(path: number[]): void {
    const node = getNodeByPath(this.tree, path);
    if (!node) return;

    const currentState = TreeOperations.isCheckboxChecked(node);
    this.setNodeCheckboxByPath(path, !currentState);
  }

  applyTreeDiff(result: TreeOperationResult): void {
    const updatedPaths = PathDiffApplier.applyChangesToPaths(result.changes, {
      focused: this.focusedNodePath,
      editing: this.editingNodePath,
      collapsed: this._collapsedNodePaths,
    });

    this.focusedNodePath = updatedPaths.focused;
    this.editingNodePath = updatedPaths.editing;
    this._collapsedNodePaths = updatedPaths.collapsed;

    this.requestUpdate();
  }
  declare mentionQuery: string;
  declare selectedMentionIndex: number;

  editingNodePath: number[] | null = null;
  private editingContent: string = "";

  // Subscription cleanup function
  private _unsubscribe: (() => void) | null = null;

  // Node indexer for stable DOM element IDs
  private nodeIndexer = NodeUtils.createNodeIndexer();

  // Test API - expose internal state for testing
  get testAPI() {
    return {
      editingNodePath: this.editingNodePath,
      editingContent: this.editingContent,
      // Compatibility: provide editing node for tests
      editingNode: this.editingNodePath
        ? getNodeByPath(this.tree, this.editingNodePath)
        : null,
      // Path-based methods for testing
      deleteNodeByPath: (path: number[]) => this.deleteNodeByPath(path),
      indentNodeByPath: (path: number[]) => this.indentNodeByPath(path),
      outdentNodeByPath: (path: number[]) => this.outdentNodeByPath(path),
      emitChange: () => this.emitChange(),
      startEditing: (node: OutlineTreeNode) => this.startEditing(node),
      handleKeyDown: (event: KeyboardEvent) => this.handleKeyDown(event),
      handleEditorKeyDown: (event: KeyboardEvent) =>
        this.handleEditorKeyDown(event),
      handleMentionKeyDown: (event: KeyboardEvent) =>
        this.handleMentionKeyDown(event),
      handleNormalEditorKeyDown: (event: KeyboardEvent) =>
        this.handleNormalEditorKeyDown(event),
      getNodeIndex: (node: OutlineTreeNode) => this.getNodeIndex(node),
      handleCharmLinkClick: (event: MouseEvent) =>
        this.handleCharmLinkClick(event),
      encodeCharmForHref: (charm: Charm) => this.encodeCharmForHref(charm),
      insertMention: (mention: MentionableItem) => this.insertMention(mention),
    };
  }

  static override styles = css`
    :host {
      display: block;
      width: 100%;

      --background: #ffffff;
      --foreground: #0f172a;
      --border: #e2e8f0;
      --ring: #94a3b8;
      --muted: #f8fafc;
      --muted-foreground: #64748b;

      --outliner-font-size: 0.875rem;
      --outliner-line-height: 1.25;
      --outliner-indent: 1.5rem;
      --outliner-bullet-size: 0.375rem;
      --outliner-padding: 0.5rem;
    }

    .outliner {
      font-size: var(--outliner-font-size);
      line-height: var(--outliner-line-height);
      color: var(--foreground);
      padding: var(--outliner-padding);
    }

    .node {
      position: relative;
      user-select: none;
    }

    .node-content {
      display: flex;
      align-items: center;
      padding: 0.125rem 0.25rem;
      cursor: pointer;
      border-radius: 0.25rem;
      transition: background-color 0.1s;
      min-height: 1.5rem;
    }

    .node-content:hover {
      background-color: var(--muted);
    }

    .node-content.focused {
      background-color: var(--muted);
      outline: 2px solid var(--ring);
      outline-offset: -2px;
    }

    .node-content.editing {
      cursor: text;
    }

    .bullet {
      width: var(--outliner-bullet-size);
      height: var(--outliner-bullet-size);
      background-color: var(--foreground);
      border-radius: 50%;
      margin-right: 0.5rem;
      flex-shrink: 0;
    }

    .collapse-icon {
      width: 1rem;
      height: 1rem;
      margin-right: 0.25rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      opacity: 0.4;
      transition: opacity 0.1s;
    }

    .collapse-icon:hover {
      opacity: 0.8;
    }

    .collapse-icon.invisible {
      opacity: 0;
      cursor: default;
    }

    .collapse-icon svg {
      width: 0.75rem;
      height: 0.75rem;
      fill: var(--muted-foreground);
      transition: transform 0.2s;
    }

    .collapse-icon.collapsed svg {
      transform: rotate(-90deg);
    }

    .content {
      flex: 1;
      word-break: break-word;
      line-height: var(--outliner-line-height);
      font-size: var(--outliner-font-size);
    }

    .content-editor {
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      font: inherit;
      color: inherit;
      resize: none;
      padding: 0;
      margin: 0;
      line-height: var(--outliner-line-height);
      font-size: var(--outliner-font-size);
    }

    .placeholder {
      color: var(--muted-foreground);
      font-style: italic;
    }

    .markdown-content {
      /* Enable inline formatting but maintain single line */
      display: inline;
    }

    .markdown-content p {
      display: inline;
      margin: 0;
    }

    .markdown-content a {
      color: var(--ring);
      text-decoration: underline;
      cursor: pointer;
    }

    .markdown-content a:hover {
      opacity: 0.8;
    }

    .markdown-content strong {
      font-weight: 600;
    }

    .markdown-content em {
      font-style: italic;
    }

    .markdown-content code {
      background-color: var(--muted);
      padding: 0.125rem 0.25rem;
      border-radius: 0.125rem;
      font-family: monospace;
      font-size: 0.875em;
    }

    .children {
      margin-left: var(--outliner-indent);
    }

    .outliner:focus {
      outline: none;
    }

    .mentions-dropdown {
      position: fixed;
      background: var(--background);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.1),
        0 4px 6px -2px rgba(0, 0, 0, 0.05);
      max-height: 200px;
      overflow-y: auto;
      z-index: 1000;
      min-width: 200px;
    }

    .mention-item {
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
      transition: background-color 0.1s;
    }

    .mention-item:last-child {
      border-bottom: none;
    }

    .mention-item:hover,
    .mention-item.selected {
      background-color: var(--muted);
    }

    .mention-name {
      font-weight: 500;
      color: var(--foreground);
    }

    .mention-charm {
      font-size: 0.75rem;
      color: var(--muted-foreground);
      margin-top: 0.125rem;
    }

    .charm-link {
      color: var(--ring);
      text-decoration: none;
      cursor: pointer;
      border-bottom: 1px solid transparent;
      transition: border-color 0.2s;
    }

    .charm-link:hover {
      border-bottom-color: var(--ring);
    }

    /* Checkbox styles */
    .checkbox-content {
      display: inline-flex;
      align-items: baseline;
      gap: 0.5rem;
    }

    .node-checkbox {
      margin: 0;
      cursor: pointer;
      width: 1rem;
      height: 1rem;
      flex-shrink: 0;
      accent-color: var(--ring);
    }

    /* Hide bullet when checkbox is present */
    .node-content:has(.checkbox-content) .bullet {
      display: none;
    }

    /* Attachment styles */
    .attachments {
      margin-top: 0.5rem;
      margin-left: 1rem;
      border-left: 2px solid var(--border);
      padding-left: 0.75rem;
    }

    .attachment {
      margin-bottom: 0.5rem;
      border-radius: 0.25rem;
      background-color: var(--muted);
      padding: 0.5rem;
      border: 1px solid var(--border);
    }

    .attachment:last-child {
      margin-bottom: 0;
    }

    .attachment-error {
      color: var(--muted-foreground);
      font-style: italic;
      padding: 0.25rem;
      background-color: var(--background);
      border: 1px dashed var(--border);
      border-radius: 0.25rem;
    }
  `;

  constructor() {
    super();
    this.readonly = false;
    this._collapsedNodePaths = new Set<string>();
    this.focusedNodePath = null;
    this.showingMentions = false;
    this.mentionQuery = "";
    this.selectedMentionIndex = 0;
    this.value = null;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set initial focus to first node if we have nodes
    if (
      this.value && this.tree.root.children.length > 0 && !this.focusedNodePath
    ) {
      this.focusedNodePath = [0]; // First child of root
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    // Handle value changes
    if (changedProperties.has("value")) {
      // Clean up previous subscription
      if (this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
      }

      // Subscribe to new Cell if it exists
      if (this.value && isCell(this.value)) {
        this._unsubscribe = this.value.sink(() => {
          this.emit("ct-change", { value: this.tree });
          // Handle focus restoration after tree changes
          if (this.focusedNodePath) {
            const focusedNode = getNodeByPath(this.tree, this.focusedNodePath);
            if (!focusedNode) {
              // Node no longer exists, find a valid focus
              // Simply focus the first node if available
              if (this.tree.root.children.length > 0) {
                this.focusedNodePath = [0]; // Focus first child of root
              } else {
                this.focusedNodePath = null;
              }
            }
          }
          this.requestUpdate();
        });
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up subscription
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  private getNodeIndex(node: OutlineTreeNode): number {
    return this.nodeIndexer.getIndex(node);
  }

  // =============================================================================
  // Cell Path Navigation Utilities - moved to node-path.ts
  // =============================================================================

  private getAllNodes(): OutlineTreeNode[] {
    return NodeUtils.getAllNodesExcludingRoot(this.tree);
  }

  getAllVisibleNodes(): OutlineTreeNode[] {
    // Use the compatibility getter to convert path-based collapsed nodes to node-based
    return NodeUtils.getVisibleNodes(this.tree, this.collapsedNodes);
  }

  emitChange() {
    // Manual change emission for non-Cell fallback scenarios
    // In normal Cell usage, changes are handled automatically by subscriptions
    this.emit("ct-change", { value: this.tree });
  }

  /**
   * Export the current tree content as markdown string
   *
   * @returns Markdown representation of the tree structure
   * @example
   * ```typescript
   * const markdown = outliner.toMarkdown();
   * // Returns: "- Item 1\n  - Child item\n- Item 2"
   * ```
   */
  toMarkdown(): string {
    return TreeOperations.toMarkdown(this.tree);
  }




  /**
   * Finish editing the current node and save changes
   *
   * @description Saves the current editing content to the node body and exits edit mode.
   * Uses Cell operations for direct mutations.
   */
  finishEditing() {
    if (!this.value || !this.editingNodePath) return;

    // Use the stored path to get the Cell
    const nodeBodyCell = getNodeBodyCellByPath(this.value, this.editingNodePath);
    if (nodeBodyCell) {
      mutateCell(nodeBodyCell, (cell) => cell.set(this.editingContent));
    }

    this.focusedNodePath = this.editingNodePath;
    this.editingNodePath = null;
    this.editingContent = "";
    this.requestUpdate();
    OutlinerEffects.focusOutliner(this.shadowRoot);
  }


  private handleNodeClick(
    node: OutlineTreeNode,
    nodePath: number[],
    event: MouseEvent,
  ) {
    if (this.readonly) return;
    event.stopPropagation();

    // Check if we're editing a different node
    if (this.editingNodePath) {
      const isEditingDifferentNode =
        this.editingNodePath.length !== nodePath.length ||
        !this.editingNodePath.every((val, idx) => val === nodePath[idx]);

      if (isEditingDifferentNode) {
        this.finishEditing();
      }
    }

    this.focusedNodePath = nodePath;
    this.requestUpdate();
  }

  private handleNodeDoubleClick(
    node: OutlineTreeNode,
    nodePath: number[],
    event: MouseEvent,
  ) {
    if (this.readonly) return;
    event.stopPropagation();
    this.startEditingByPath(nodePath, node.body);
  }

  private handleCollapseClick(
    node: OutlineTreeNode,
    nodePath: number[],
    event: MouseEvent,
  ) {
    event.stopPropagation();

    const pathStr = pathToString(nodePath);
    if (this._collapsedNodePaths.has(pathStr)) {
      this._collapsedNodePaths.delete(pathStr);
    } else {
      this._collapsedNodePaths.add(pathStr);
    }

    this.requestUpdate();
  }

  private handleEditorInput(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    this.editingContent = target.value;

    // Check for @ mentions
    const cursorPos = target.selectionStart;
    const textBeforeCursor = this.editingContent.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex !== -1 && lastAtIndex === textBeforeCursor.length - 1) {
      // Just typed @
      this.showingMentions = true;
      this.mentionQuery = "";
      this.selectedMentionIndex = 0;
      this.requestUpdate();
    } else if (lastAtIndex !== -1 && this.showingMentions) {
      // Update query
      const query = textBeforeCursor.substring(lastAtIndex + 1);
      if (!query.includes(" ")) {
        this.mentionQuery = query;
        this.selectedMentionIndex = 0;
        this.requestUpdate();
      } else {
        this.showingMentions = false;
        this.requestUpdate();
      }
    }

    // Auto-resize textarea
    target.style.height = "auto";
    target.style.height = `${target.scrollHeight}px`;
  }

  private handleEditorBlur() {
    // Use a timeout to allow click events on mentions to fire first
    setTimeout(() => {
      if (this.editingNodePath && !this.showingMentions) {
        this.finishEditing();
      }
    }, 200);
  }

  private handleEditorPaste(event: ClipboardEvent) {
    if (!this.editingNodePath) return;

    const pastedText = event.clipboardData?.getData("text/plain");
    if (!pastedText || !pastedText.includes("\n")) {
      // Let default paste behavior handle single-line pastes
      return;
    }

    event.preventDefault();

    // Handle multi-line paste by creating new nodes
    const lines = pastedText.split("\n").filter((line) => line.trim());
    if (lines.length === 0) return;

    // Update current node with first line
    const target = event.target as HTMLTextAreaElement;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const newContent = this.editingContent.substring(0, start) +
      lines[0] +
      this.editingContent.substring(end);

    this.editingContent = newContent;
    target.value = newContent;

    // Create new nodes for remaining lines
    if (lines.length > 1) {
      this.finishEditing();

      const focusedNodePath = this.focusedNodePath;
      if (!focusedNodePath || !this.value) return;
      const focusedNodeCell = getNodeCellByPath(this.value, focusedNodePath) as Cell<OutlineTreeNode>;
      if (!focusedNodeCell) return;

      const parentNode = TreeOperations.findParentNodeCell(
        this.value.key("root"),
        focusedNodeCell,
      );
      if (parentNode) {
        const nodeIndex = TreeOperations.getNodeIndex(
          parentNode,
          focusedNodeCell,
        );

        // Insert new nodes after current one using Cell operations
        const parentChildrenCell = getNodeChildrenCell(this.value, this.tree, parentNode);
        if (parentChildrenCell) {
          mutateCell(parentChildrenCell, (cell) => {
            const currentChildren = cell.get();
            const newChildren = [...currentChildren];

            // Insert all new nodes at once using immutable operations
            const nodesToInsert = lines.slice(1).map((line) =>
              TreeOperations.createNode({ body: line })
            );
            const beforeInsert = newChildren.slice(0, nodeIndex + 1);
            const afterInsert = newChildren.slice(nodeIndex + 1);
            const finalChildren = [
              ...beforeInsert,
              ...nodesToInsert,
              ...afterInsert,
            ];

            cell.set(finalChildren);
          });
        }
      }
    }
  }

  private handleEditorKeyDown(event: KeyboardEvent) {
    if (this.showingMentions) {
      this.handleMentionKeyDown(event);
      return;
    }
    this.handleNormalEditorKeyDown(event);
  }

  private handleMentionKeyDown(event: KeyboardEvent) {
    const filteredMentions = this.getFilteredMentions();

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.selectedMentionIndex = Math.min(
          this.selectedMentionIndex + 1,
          filteredMentions.length - 1,
        );
        this.requestUpdate();
        break;
      case "ArrowUp":
        event.preventDefault();
        this.selectedMentionIndex = Math.max(this.selectedMentionIndex - 1, 0);
        this.requestUpdate();
        break;
      case "Enter":
        event.preventDefault();
        if (filteredMentions[this.selectedMentionIndex]) {
          this.insertMention(filteredMentions[this.selectedMentionIndex]);
        }
        break;
      case "Escape":
        event.preventDefault();
        this.showingMentions = false;
        this.requestUpdate();
        break;
    }
  }

  private handleNormalEditorKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLTextAreaElement;

    // Try executing editing keyboard commands first
    const editingNode = getNodeByPath(this.tree, this.editingNodePath!);
    if (!editingNode) return;

    const editingContext = EventUtils.createEditingKeyboardContext(
      event,
      this,
      editingNode,
      this.editingContent,
      target,
    );

    if (executeEditingKeyboardCommand(event.key, editingContext)) {
      return;
    }

    switch (event.key) {
      case "Enter":
        event.preventDefault();
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey) {
          // cmd/ctrl+Enter should just exit edit mode, not create new node
          this.finishEditing();
        } else {
          this.finishEditing();
        }
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.cancelEditing();
        break;
      case "Tab":
        event.preventDefault();
        this.handleIndentation(event.shiftKey);
        break;
      case "Backspace":
        if (
          this.editingContent === "" ||
          (target.selectionStart === 0 && this.editingContent === "")
        ) {
          event.preventDefault();
          this.deleteCurrentNode();
        }
        break;
      case "Delete":
        if (target.selectionStart === this.editingContent.length) {
          const allNodes = this.getAllNodes();
          const editingNode = getNodeByPath(this.tree, this.editingNodePath!);
          if (!editingNode) return;
          const currentNodeIndex = allNodes.indexOf(editingNode);
          if (
            currentNodeIndex !== -1 && currentNodeIndex < allNodes.length - 1
          ) {
            event.preventDefault();
            this.mergeWithNextNode();
          }
        }
        break;
    }
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (this.readonly || this.editingNodePath) return;

    // Ensure we have a focused node before proceeding
    if (!this.focusedNodePath) {
      console.warn("No focused node available for keyboard command");
      return;
    }

    const focusedNode = getNodeByPath(this.tree, this.focusedNodePath);
    if (!focusedNode) {
      console.warn("Focused node no longer exists");
      return;
    }

    const context = EventUtils.createKeyboardContext(
      event,
      this,
      focusedNode,
    );

    // Use new path-based keyboard command handler
    const pathBasedContext = {
      event: event,
      component: this,
      allNodes: this.getAllNodes(),
      currentIndex: focusedNode ? this.getAllNodes().indexOf(focusedNode) : -1,
      focusedNodePath: this.focusedNodePath,
    };
    executePathBasedKeyboardCommand(event.key, pathBasedContext);
  }


  /**
   * Create a new sibling node after the specified node
   *
   * @param node - The node Cell to create a sibling after
   * @description Creates an empty node as a sibling after the given node,
   * focuses it, and immediately enters edit mode. Uses Cell operations.
   */
  private async createNewNodeAfterCell(node: Cell<OutlineTreeNode>) {
    if (!this.value) return;

    const parentNode = TreeOperations.findParentNodeCell(this.value.key('root'), node);
    if (!parentNode) return;

    const nodeIndex = TreeOperations.getNodeIndex(parentNode, node);
    const newNode = TreeOperations.createNode({ body: "" });

    // Find parent path by working backwards from the current node path
    // First get the current node's path by finding it in the tree structure
    const currentNodeValue = node.getAsQueryResult();
    const currentNodePath = this.findNodePathInTree(currentNodeValue);
    if (!currentNodePath) {
      console.error("Cannot find current node path in tree");
      return;
    }

    const parentPath = currentNodePath.slice(0, -1); // Remove last index to get parent path
    const newNodePath = [...parentPath, nodeIndex + 1]; // Insert after current node

    const parentChildrenCell = getNodeChildrenCell(this.value, this.tree, parentNode);
    if (parentChildrenCell) {
      await mutateCell(parentChildrenCell, (cell) => {
        const currentChildren = cell.get();

        // Build new children array with the new node inserted
        const newChildren = [
          ...currentChildren.slice(0, nodeIndex + 1),
          newNode,
          ...currentChildren.slice(nodeIndex + 1),
        ];

        cell.set(newChildren);
      });
    }

    // Use the calculated path instead of trying to find the node
    this.focusedNodePath = newNodePath;
    this.editingNodePath = newNodePath;
    this.editingContent = "";
    this.requestUpdate();

    // Focus the editor after the update
    setTimeout(() => {
      const newNodeFromTree = getNodeByPath(this.tree, newNodePath);
      if (newNodeFromTree) {
        const nodeIndex = this.getNodeIndex(newNodeFromTree);
        OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
      }
    }, 0);
  }

  /**
   * Find the path to a node by searching through the tree structure
   * This is more reliable than trying to get paths from Cell references
   */
  private findNodePathInTree(targetNode: OutlineTreeNode): number[] | null {
    return getNodePath(this.tree, targetNode);
  }



  /**
   * Start editing with initial text by path instead of node reference
   *
   * @param path - The path to the node to start editing
   * @param initialText - The initial text to start with
   * @description Enters edit mode for the node at the specified path with initial text.
   */
  startEditingWithInitialTextByPath(path: number[], initialText: string) {
    if (this.readonly) return;

    this.editingNodePath = path;
    this.editingContent = initialText; // Replace entire content with initial text
    this.requestUpdate();

    // Get the node by path to determine its index for focusing
    const node = getNodeByPath(this.tree, path);
    if (node) {
      const nodeIndex = this.getNodeIndex(node);
      // Focus the editor and select all text so typing replaces content
      OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
    }
  }










  private deleteCurrentNode() {
    if (!this.editingNodePath) return;

    this.cancelEditing();
    // Use the new path-based delete method
    if (this.focusedNodePath) {
      this.deleteNodeByPath(this.focusedNodePath);
    }
  }

  private mergeWithNextNode() {
    if (!this.editingNodePath) return;

    const editingNode = getNodeByPath(this.tree, this.editingNodePath);
    if (!editingNode) return;

    const allNodes = this.getAllNodes();
    const currentIndex = allNodes.indexOf(editingNode);

    if (currentIndex === -1 || currentIndex >= allNodes.length - 1) return;

    const nextNode = allNodes[currentIndex + 1];
    const nextNodePath = getNodePath(this.tree, nextNode);
    if (!nextNodePath) return;

    const mergedContent = this.editingContent + nextNode.body;
    const cursorPosition = this.editingContent.length;

    // Update current node with merged content
    this.editingContent = mergedContent;
    this.finishEditing();

    // Delete the next node using the new path-based method
    this.deleteNodeByPath(nextNodePath);

    // Re-enter editing mode at the merge point
    if (this.focusedNodePath) {
      this.startEditingByPath(this.focusedNodePath);
      const focusedNode = getNodeByPath(this.tree, this.focusedNodePath);
      if (focusedNode) {
        const nodeIndex = this.getNodeIndex(focusedNode);
        OutlinerEffects.setCursorPosition(
          this.shadowRoot,
          nodeIndex,
          cursorPosition,
        );
      }
    }
  }

  private handleIndentation(shiftKey: boolean) {
    if (!this.editingNodePath) return;

    this.finishEditing();

    if (!this.focusedNodePath) {
      console.warn("No focused node path available for indentation");
      return;
    }

    if (shiftKey) {
      // Outdent - use new path-based method
      this.outdentNodeByPath(this.focusedNodePath);
    } else {
      // Indent - use new path-based method
      this.indentNodeByPath(this.focusedNodePath);
    }

    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  private getFilteredMentions(): Charm[] {
    if (!this.mentionable || this.mentionable.getAsQueryResult().length === 0) return [];

    const query = this.mentionQuery.toLowerCase();
    const matches = [];

    const flattened = this.mentionable.getAsQueryResult();
    for (const mention of flattened) {
      if (mention[NAME]?.toLowerCase()?.includes(query)) {
        matches.push(flattened.indexOf(mention));
      }
    }

    return matches.map((i) => this.mentionable.key(i).getAsQueryResult());
  }

  private async insertMention(mention: Charm) {
    if (!this.editingNodePath) return;

    const editingNode = getNodeByPath(this.tree, this.editingNodePath);
    if (!editingNode) return;

    const textarea = this.shadowRoot?.querySelector(
      `#editor-${this.getNodeIndex(editingNode)}`,
    ) as HTMLTextAreaElement;

    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = this.editingContent.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex === -1) return;

    const beforeMention = this.editingContent.substring(0, lastAtIndex);
    const afterMention = this.editingContent.substring(cursorPos);

    // Create markdown link with encoded charm reference
    const charmHref = await this.encodeCharmForHref(mention);
    const mentionText = `[${mention[NAME]}](${charmHref})`;

    this.editingContent = beforeMention + mentionText + afterMention;
    textarea.value = this.editingContent;

    // Set cursor after the inserted mention
    const newCursorPos = beforeMention.length + mentionText.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);

    this.showingMentions = false;
    this.mentionQuery = "";
    this.requestUpdate();

    // Refocus the editor
    textarea.focus();
  }

  private async generateHash(input: string) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return hashHex;
  }

  private async encodeCharmForHref(charm: Charm) {
    const id = await this.generateHash(charm[NAME] ?? "");
    return id;
  }

  /**
   * Decode charm reference from href
   */
  private async decodeCharmFromHref(href: string | null): Promise<Charm> {
    // Check if hash matches any mentionable charm
    let match = -1;
    const flattened = this.mentionable.getAsQueryResult() || [];
    for (const mention of flattened) {
      const mentionHash = await this.generateHash(mention[NAME] || "");
      if (mentionHash === href) {
        match = flattened.indexOf(mention);
        break;
      }
    }

    return this.mentionable.key(match).getAsQueryResult();
  }

  /**
   * Handle click on charm links
   */
  private async handleCharmLinkClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("charm-link")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const href = target.getAttribute("data-href") ||
      target.getAttribute("href");
    const text = target.getAttribute("data-text") || target.textContent;

    if (!href) {
      return;
    }

    const charm = await this.decodeCharmFromHref(href);
    if (!charm) {
      return;
    }

    // Emit the charm-link-click event
    this.emit("charm-link-click", {
      href,
      text: text || "",
      charm,
    });
  }

  /**
   * Handle checkbox change event to sync state
   */
  private handleCheckboxChange(
    node: OutlineTreeNode,
    nodePath: number[],
    event: Event,
  ) {
    const checkbox = event.target as HTMLInputElement;
    const isChecked = checkbox.checked;

    // Update the node's body to match the checkbox state
    this.setNodeCheckboxByPath(nodePath, isChecked);
  }




  private handleOutlinerClick(event: MouseEvent) {
    const target = event.target as HTMLElement;

    // Handle charm link clicks
    if (target.matches("a.charm-link")) {
      event.preventDefault();
      const href = target.getAttribute("href");
      const text = target.textContent;

      // Emit a custom event for charm link clicks
      this.emit("charm-link-click", {
        href,
        text,
        charm: this.decodeCharmFromHref(href),
      });
      return;
    }

    // Handle clicks on the main placeholder (when no nodes exist)
    if (
      target.matches(".placeholder") &&
      (!this.tree || this.tree.root.children.length === 0)
    ) {
      event.preventDefault();

      // Create new node using Cell operations
      const newNode = TreeOperations.createNode({ body: "" });

      if (this.value) {
        const rootChildrenCell = this.value.key("root").key("children") as Cell<
          OutlineTreeNode[]
        >;
        mutateCell(rootChildrenCell, (cell) => {
          cell.set([newNode]);
        });
      }

      // For the first node, the path is [0]
      const newNodePath = [0];
      this.focusedNodePath = newNodePath;
      this.editingNodePath = newNodePath;
      this.editingContent = "";
      this.requestUpdate();

      // Focus the editor after the update
      setTimeout(() => {
        const newNodeFromTree = getNodeByPath(this.tree, newNodePath);
        if (newNodeFromTree) {
          const nodeIndex = this.getNodeIndex(newNodeFromTree);
          OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
        }
      }, 0);
    }
  }

  private handleOutlinerPaste(event: ClipboardEvent) {
    // Only handle paste when not editing
    if (this.editingNodePath || this.readonly) return;

    const pastedText = event.clipboardData?.getData("text/plain");
    if (!pastedText) return;

    event.preventDefault();

    // Parse the pasted markdown into a tree structure
    const parsedTree = TreeOperations.parseMarkdownToTree(pastedText);

    if (parsedTree.root.children.length === 0) return;

    if (this.focusedNodePath) {
      const focusedNode = getNodeByPath(this.tree, this.focusedNodePath);
      if (!focusedNode) return;

      const focusedNodeCell = this.value ? getNodeCellByPath(this.value, this.focusedNodePath) as Cell<OutlineTreeNode> : null;
      if (!focusedNodeCell || !this.value) return;

      const parentNode = TreeOperations.findParentNodeCell(
        this.value.key("root"),
        focusedNodeCell,
      );

      if (parentNode) {
        const nodeIndex = TreeOperations.getNodeIndex(
          parentNode,
          focusedNodeCell,
        );

        // Insert all parsed nodes after the focused node using Cell operations
        const parentChildrenCell = getNodeChildrenCell(this.value, this.tree, parentNode);
        if (parentChildrenCell) {
          mutateCell(parentChildrenCell, (cell) => {
            const currentChildren = cell.get();
            const beforeInsert = currentChildren.slice(0, nodeIndex + 1);
            const afterInsert = currentChildren.slice(nodeIndex + 1);
            const newChildren = [
              ...beforeInsert,
              ...parsedTree.root.children,
              ...afterInsert,
            ];

            cell.set(newChildren);
          });
        }

        // Focus the first newly inserted node - calculate the path instead of using reference
        const parentPath = getNodePath(this.tree, parentNode);
        if (parentPath !== null) {
          const firstNewNodePath = [...parentPath, nodeIndex + 1];
          this.focusedNodePath = firstNewNodePath;
        }
      }
    } else if (this.tree.root.children.length === 0) {
      // No nodes exist, replace root children using Cell operations
      if (this.value) {
        const rootChildrenCell = this.value.key("root").key("children") as Cell<
          OutlineTreeNode[]
        >;
        mutateCell(rootChildrenCell, (cell) => {
          cell.set(parsedTree.root.children);
        });
      }
      // For root children, the first new node will be at path [0]
      this.focusedNodePath = [0];
    } else {
      // No focused node but tree has nodes, append to the end using Cell operations
      if (this.value) {
        const rootChildrenCell = this.value.key("root").key("children") as Cell<
          OutlineTreeNode[]
        >;
        mutateCell(rootChildrenCell, (cell) => {
          const currentChildren = cell.get();
          const newChildren = [...currentChildren, ...parsedTree.root.children];
          cell.set(newChildren);
        });
      }
      // The first new node will be appended at the end
      const currentRootChildrenCount = this.tree.root.children.length;
      this.focusedNodePath = [currentRootChildrenCount];
    }

    this.requestUpdate();
  }

  override render() {
    if (!this.value) {
      return html`
        <div style="position: relative;">
          <div class="outliner" tabindex="0">
            <div class="placeholder">No value provided</div>
          </div>
        </div>
      `;
    }

    const hasNodes = this.tree && this.tree.root.children.length > 0;

    return html`
      <div style="position: relative;">
        <div
          class="outliner"
          @keydown="${this.handleKeyDown}"
          @click="${this.handleOutlinerClick}"
          @paste="${this.handleOutlinerPaste}"
          tabindex="0"
        >
          ${!hasNodes
        ? html`
          <div class="placeholder">Click to start typing...</div>
        `
        : this.renderNodes(this.value.key("root").key("children"), 0, [])}
        </div>
      </div>
    `;
  }

  private renderNodes(
    nodes: Cell<OutlineTreeNode[]>,
    level: number,
    parentPath: number[] = [],
  ): unknown {
    return repeat(
      nodes.getAsQueryResult() as OutlineTreeNode[],
      (node) => this.getNodeIndex(node),
      (node, index) =>
        this.renderNode(nodes.key(index), level, [...parentPath, index]),
    );
  }

  private renderNode(
    node: Cell<OutlineTreeNode>,
    level: number,
    calculatedPath: number[],
  ): unknown {
    // Defensive check for corrupted nodes
    const instance = node.getAsQueryResult();
    if (
      !instance || typeof instance !== "object" ||
      !Array.isArray(instance.children)
    ) {
      debugger;
      console.error("Corrupted node in renderNode:", instance);
      return html`
        <div class="error">Corrupted node</div>
      `;
    }

    // Use calculated path from renderNodes instead of getNodePath to avoid timing issues
    // Create a local copy to ensure it's captured properly in event handlers
    const pathArray = [...calculatedPath];

    const hasChildren = instance.children.length > 0;

    // Check if this node is being edited
    const isEditing = this.editingNodePath &&
      this.editingNodePath.length === calculatedPath.length &&
      this.editingNodePath.every((val, idx) => val === calculatedPath[idx]);

    // Check if this node is focused
    const isFocused = this.focusedNodePath &&
      this.focusedNodePath.length === calculatedPath.length &&
      this.focusedNodePath.every((val, idx) => val === calculatedPath[idx]);

    const isCollapsed = this._collapsedNodePaths.has(
      pathToString(calculatedPath),
    );
    const nodeIndex = this.getNodeIndex(instance);

    // Create event handlers that capture the path correctly
    const nodeClickHandler = (e: MouseEvent) =>
      this.handleNodeClick(instance, pathArray, e);
    const nodeDoubleClickHandler = (e: MouseEvent) =>
      this.handleNodeDoubleClick(instance, pathArray, e);
    const collapseClickHandler = (e: MouseEvent) =>
      this.handleCollapseClick(instance, pathArray, e);
    const checkboxChangeHandler = (e: Event) => {
      e.stopPropagation();
      this.handleCheckboxChange(instance, pathArray, e);
    };

    console.log("renderNode", node, instance);
    return html`
      <div class="node" style="position: relative;">
        <div
          class="node-content ${isFocused ? "focused" : ""} ${isEditing
        ? "editing"
        : ""}"
          @click="${nodeClickHandler}"
          @dblclick="${nodeDoubleClickHandler}"
        >
          <div
            class="collapse-icon ${isCollapsed ? "collapsed" : ""} ${hasChildren
        ? ""
        : "invisible"}"
            @click="${collapseClickHandler}"
          >
            <svg viewBox="0 0 24 24">
              <path d="M7 10l5 5 5-5H7z" />
            </svg>
          </div>

          <div class="bullet"></div>

          <div class="content">
            ${isEditing
        ? html`
          <textarea
            id="editor-${nodeIndex}"
            class="content-editor"
            .value="${this.editingContent}"
            @input="${this.handleEditorInput}"
            @keydown="${this.handleEditorKeyDown}"
            @blur="${this.handleEditorBlur}"
            @paste="${this.handleEditorPaste}"
            rows="1"
          ></textarea>
          ${this.showingMentions ? this.renderMentionsDropdown() : ""}
        `
        : this.renderMarkdownContent(
          instance.body,
          instance,
          checkboxChangeHandler,
        )}
          </div>
        </div>

        ${this.renderAttachments(node)} ${hasChildren && !isCollapsed
        ? html`
          <div class="children">
            ${this.renderNodes(node.key("children"), level + 1, calculatedPath)}
          </div>
        `
        : ""}
      </div>
    `;
  }

  private renderMentionsDropdown(): unknown {
    const filteredMentions = this.getFilteredMentions();

    if (filteredMentions.length === 0) {
      return "";
    }

    if (!this.editingNodePath) {
      return "";
    }

    const editingNode = getNodeByPath(this.tree, this.editingNodePath);
    if (!editingNode) {
      return "";
    }

    // Calculate position relative to viewport for fixed positioning
    const editor = this.shadowRoot?.querySelector(
      `#editor-${this.getNodeIndex(editingNode)}`,
    ) as HTMLTextAreaElement;
    let style = "top: 100%; left: 0;";

    if (editor) {
      const rect = editor.getBoundingClientRect();
      style = `top: ${rect.bottom + 2}px; left: ${rect.left}px;`;
    }

    return html`
      <div class="mentions-dropdown" style="${style}">
        ${filteredMentions.map((mention, index) =>
        html`
          <div
            class="mention-item ${index === this.selectedMentionIndex
            ? "selected"
            : ""}"
            @click="${() => this.insertMention(mention)}"
            @mouseenter="${() => {
            this.selectedMentionIndex = index;
            this.requestUpdate();
          }}"
          >
            <div class="mention-name">${mention[NAME]}</div>
          </div>
        `
      )}
      </div>
    `;
  }

  private renderMarkdownContent(
    content: string,
    node: OutlineTreeNode,
    checkboxChangeHandler?: (e: Event) => void,
  ): unknown {
    if (!content.trim()) {
      return html`
        <span class="placeholder">Empty</span>
      `;
    }

    // Check for checkbox at the beginning
    const checkboxState = TreeOperations.getCheckboxState(node);
    const contentWithoutCheckbox = TreeOperations.getBodyWithoutCheckbox(node);

    try {
      // Configure marked for inline content (no paragraphs)
      const renderer = new marked.Renderer();

      // Override paragraph to not wrap in <p> tags for inline content
      renderer.paragraph = (text: string) => text;

      // Override link to handle charm references
      renderer.link = (href: string, title: string | null, text: string) => {
        // For charm links, we'll add a special class and handle clicks
        const titleAttr = title ? ` title="${title}"` : "";
        return `<a href="${href}" class="charm-link" data-href="${href}" data-text="${text}"${titleAttr}>${text}</a>`;
      };

      const html_content = marked.parse(contentWithoutCheckbox, {
        renderer,
        breaks: false,
        gfm: true,
      });

      if (checkboxState !== null) {
        const isChecked = checkboxState === "checked";
        return html`
          <span class="checkbox-content">
            <input
              type="checkbox"
              class="node-checkbox"
              ?checked="${isChecked}"
              @change="${checkboxChangeHandler || ((e: Event) => {
            e.stopPropagation();
            this.handleCheckboxChange(node, getNodePath(this.tree, node) || [], e);
          })}"
            />
            <span class="markdown-content" @click="${this
            .handleCharmLinkClick}">${unsafeHTML(html_content)}</span>
          </span>
        `;
      }

      return html`
        <span class="markdown-content" @click="${this
          .handleCharmLinkClick}">${unsafeHTML(html_content)}</span>
      `;
    } catch (error) {
      // Fallback to plain text if markdown parsing fails
      return html`
        <span>${content}</span>
      `;
    }
  }

  /**
   * Render attachments for a node using ct-render
   */
  private renderAttachments(node: Cell<OutlineTreeNode>): unknown {
    const attachments = node.key('attachments').getAsQueryResult() as Charm[];

    if (!attachments || attachments.length === 0) {
      return "";
    }

    if (!isCell(this.value)) {
      return "";
    }

    const tree: Cell<Tree> = this.value;
    const runtime = tree.runtime;
    const space = tree.space;

    // Create proper charm cell references from attachment charm objects
    const charmCells = attachments.map((attachment: Charm) => {
      try {
        // Extract entity ID from the charm object
        const entityId = getEntityId(attachment);

        if (!entityId) {
          console.warn("No entity ID found for attachment charm:", attachment);
          return null;
        }

        // Create a proper charm cell reference using the runtime
        const charmCell = runtime.getCellFromEntityId<Charm>(
          space,
          entityId,
          [],
          charmSchema,
        );

        return charmCell;
      } catch (error) {
        console.error(
          "Error creating charm cell for attachment:",
          error,
          attachment,
        );
        return null;
      }
    }).filter((cell): cell is Cell<Charm> => cell !== null);

    return html`
      <div class="attachments">
        ${charmCells.map((charmCell: Cell<Charm>) => {
        return html`
          <div class="attachment">
            <ct-render .cell="${charmCell}"></ct-render>
          </div>
        `;
      })}
      </div>
    `;
  }
}

customElements.define("ct-outliner", CTOutliner);
