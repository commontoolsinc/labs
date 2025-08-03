import { css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { BaseElement } from "../../core/base-element.ts";
import { marked } from "marked";
// Removed cell-controller import - working directly with Cell
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
} from "./types.ts";
import {
  executeEditingKeyboardCommand,
  executeKeyboardCommand,
} from "./keyboard-commands.ts";
import { TreeOperations } from "./tree-operations.ts";
import { NodeUtils } from "./node-utils.ts";
import { EventUtils } from "./event-utils.ts";
import { FocusUtils } from "./focus-utils.ts";
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

export class CTOutliner extends BaseElement {
  static override properties = {
    value: { type: Object },
    readonly: { type: Boolean },
    mentionable: { type: Array },
    tree: { type: Object, state: true },
    _collapsedNodePaths: { type: Object, state: true },
    focusedNode: { type: Object, state: true },
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
    return this.value.get();
  }
  private _collapsedNodePaths: Set<string> = new Set(); // Set of node paths as strings
  declare focusedNodePath: number[] | null;
  declare showingMentions: boolean;

  // Compatibility getters for OutlinerOperations interface
  get focusedNode(): OutlineTreeNode | null {
    if (!this.focusedNodePath) return null;
    return this.getNodeByPath(this.focusedNodePath);
  }

  set focusedNode(node: OutlineTreeNode | null) {
    this.focusedNodePath = node ? this.getNodePath(node) : null;
  }

  // Expose collapsedNodes as Set<Node> for compatibility
  get collapsedNodes(): Set<OutlineTreeNode> {
    const nodes = new Set<OutlineTreeNode>();
    for (const pathStr of this._collapsedNodePaths) {
      const path = this.stringToPath(pathStr);
      const node = this.getNodeByPath(path);
      if (node) {
        nodes.add(node);
      }
    }
    return nodes;
  }

  set collapsedNodes(nodes: Set<OutlineTreeNode>) {
    this._collapsedNodePaths.clear();
    for (const node of nodes) {
      const path = this.getNodePath(node);
      if (path) {
        this._collapsedNodePaths.add(this.pathToString(path));
      }
    }
  }
  declare mentionQuery: string;
  declare selectedMentionIndex: number;

  private editingNodePath: number[] | null = null;
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
      editingNode: this.editingNodePath ? this.getNodeByPath(this.editingNodePath) : null,
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
            const focusedNode = this.getNodeByPath(this.focusedNodePath);
            if (!focusedNode) {
              // Node no longer exists, find a valid focus
              const oldNode = {
                body: "",
                children: [],
                attachments: [],
              } as OutlineTreeNode; // Dummy node for FocusUtils
              const newFocus = FocusUtils.findValidFocus(this.tree, oldNode);
              this.focusedNodePath = newFocus
                ? this.getNodePath(newFocus)
                : null;
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
  // Cell Path Navigation Utilities
  // =============================================================================

  /**
   * Convert a path to a string for use as a key
   */
  private pathToString(path: number[]): string {
    return path.join(".");
  }

  /**
   * Convert a string key back to a path
   */
  private stringToPath(str: string): number[] {
    return str ? str.split(".").map(Number) : [];
  }

  /**
   * Get the node at a given path
   */
  private getNodeByPath(path: number[]): OutlineTreeNode | null {
    if (path.length === 0) {
      return this.tree.root;
    }

    let current = this.tree.root;
    for (const index of path) {
      if (!current.children || index >= current.children.length) {
        return null;
      }
      current = current.children[index];
    }
    return current;
  }

  /**
   * Get the path to a node as an array of indices from root.children
   */
  private getNodePath(targetNode: OutlineTreeNode): number[] | null {
    // Handle root node as a special case
    if (targetNode === this.tree.root) {
      return []; // Root node has empty path
    }

    const findPath = (
      node: OutlineTreeNode,
      currentPath: number[],
    ): number[] | null => {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const childPath = [...currentPath, i];

        if (child === targetNode) {
          return childPath;
        }

        const result = findPath(child, childPath);
        if (result) {
          return result;
        }
      }
      return null;
    };

    return findPath(this.tree.root, []);
  }

  /**
   * Get the Cell for a specific node in the tree using its path
   * @param node The target node to get a Cell for
   * @returns Cell<Node> pointing to the node, or null if not found
   */
  private getNodeCell(node: OutlineTreeNode): Cell<OutlineTreeNode> | null {
    if (!this.value) return null;

    const nodePath = this.getNodePath(node);
    if (nodePath === null) return null;

    // Handle root node (empty path)
    if (nodePath.length === 0) {
      return this.value.key("root") as Cell<OutlineTreeNode>;
    }

    let targetCell: Cell<any> = this.value.key("root").key("children");
    for (let i = 0; i < nodePath.length; i++) {
      targetCell = targetCell.key(nodePath[i]);
      if (i < nodePath.length - 1) {
        targetCell = targetCell.key("children");
      }
    }

    return targetCell as Cell<OutlineTreeNode>;
  }

  /**
   * Get the Cell for a specific node's body content
   * @param node The target node to get a body Cell for
   * @returns Cell<string> pointing to the node's body, or null if not found
   */
  private getNodeBodyCell(node: OutlineTreeNode): Cell<string> | null {
    const nodeCell = this.getNodeCell(node);
    return nodeCell ? nodeCell.key("body") as Cell<string> : null;
  }

  /**
   * Get the Cell for a node's body content using a path
   * @param nodePath The path to the node as an array of indices
   * @returns Cell<string> pointing to the node's body, or null if not found
   */
  private getNodeBodyCellByPath(nodePath: number[]): Cell<string> | null {
    if (!this.value) return null;

    // Handle root node (empty path)
    if (nodePath.length === 0) {
      return this.value.key("root").key("body") as Cell<string>;
    }

    let targetCell: Cell<any> = this.value.key("root").key("children");
    for (let i = 0; i < nodePath.length; i++) {
      targetCell = targetCell.key(nodePath[i]);
      if (i < nodePath.length - 1) {
        targetCell = targetCell.key("children");
      }
    }

    return targetCell.key("body") as Cell<string>;
  }

  /**
   * Get the Cell for a specific node's children array
   * @param node The target node to get a children Cell for
   * @returns Cell<OutlineTreeNode[]> pointing to the node's children, or null if not found
   */
  private getNodeChildrenCell(
    node: OutlineTreeNode,
  ): Cell<OutlineTreeNode[]> | null {
    const nodeCell = this.getNodeCell(node);
    return nodeCell
      ? nodeCell.key("children") as Cell<OutlineTreeNode[]>
      : null;
  }

  /**
   * Get the Cell for a parent node's children array where a specific node is located
   * @param node The child node whose parent's children Cell we want
   * @returns Cell<OutlineTreeNode[]> pointing to the parent's children array, or null if not found
   */
  private getParentChildrenCell(
    node: OutlineTreeNode,
  ): Cell<OutlineTreeNode[]> | null {
    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) return null;

    return this.getNodeChildrenCell(parentNode);
  }

  /**
   * Create a clean copy of a node to avoid proxy reference issues in Cell operations
   * @param node The node to copy
   * @returns A clean copy of the node that's safe to use in Cell operations
   */
  private createNodeCopy(node: OutlineTreeNode): OutlineTreeNode {
    return {
      body: node.body || "",
      children: (node.children || []).map((child) =>
        this.createNodeCopy(child)
      ),
      attachments: [...(node.attachments || [])],
    };
  }

  private getAllNodes(): OutlineTreeNode[] {
    return NodeUtils.getAllNodesExcludingRoot(this.tree);
  }

  getAllVisibleNodes(): OutlineTreeNode[] {
    // Use the compatibility getter
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
   * Start editing a specific node
   *
   * @param node - The node to start editing
   * @description Enters edit mode for the specified node, preserving its current content.
   * If the component is readonly, this method does nothing.
   */
  startEditing(node: OutlineTreeNode) {
    if (this.readonly) return;
    const path = this.getNodePath(node);
    if (!path) return;

    this.editingNodePath = path;
    this.editingContent = node.body;
    this.requestUpdate();
    const nodeIndex = this.getNodeIndex(node);
    OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
  }

  /**
   * Toggle edit mode for a specific node
   *
   * @param node - The node to toggle editing for
   * @description If the node is currently being edited, exits edit mode.
   * If not editing or editing a different node, starts editing this node.
   */
  toggleEditMode(node: OutlineTreeNode) {
    if (this.readonly) return;

    const nodePath = this.getNodePath(node);
    if (!nodePath) return;

    // Check if we're editing this node by comparing paths
    const isEditingThisNode = this.editingNodePath &&
      this.editingNodePath.length === nodePath.length &&
      this.editingNodePath.every((val, idx) => val === nodePath[idx]);

    if (isEditingThisNode) {
      // Currently editing this node - finish editing
      this.finishEditing();
    } else {
      // Not editing or editing different node - start editing
      this.startEditing(node);
    }
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
    const nodeBodyCell = this.getNodeBodyCellByPath(this.editingNodePath);
    if (nodeBodyCell) {
      mutateCell(nodeBodyCell, (cell) => cell.set(this.editingContent));
    }

    this.focusedNodePath = this.editingNodePath;
    this.editingNodePath = null;
    this.editingContent = "";
    this.requestUpdate();
    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  private cancelEditing() {
    if (!this.editingNodePath) return;

    this.focusedNodePath = this.editingNodePath;
    this.editingNodePath = null;
    this.editingContent = "";
    this.requestUpdate();
    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  private handleNodeClick(node: OutlineTreeNode, event: MouseEvent) {
    if (this.readonly) return;
    event.stopPropagation();

    const nodePath = this.getNodePath(node);
    if (!nodePath) return;

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

  private handleNodeDoubleClick(node: OutlineTreeNode, event: MouseEvent) {
    if (this.readonly) return;
    event.stopPropagation();
    this.startEditing(node);
  }

  private handleCollapseClick(node: OutlineTreeNode, event: MouseEvent) {
    event.stopPropagation();

    const nodePath = this.getNodePath(node);
    if (!nodePath) return;

    const pathStr = this.pathToString(nodePath);
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

      const parentNode = TreeOperations.findParentNode(
        this.tree.root,
        this.focusedNode!,
      );
      if (parentNode) {
        const nodeIndex = TreeOperations.getNodeIndex(
          parentNode,
          this.focusedNode!,
        );

        // Insert new nodes after current one using Cell operations
        const parentChildrenCell = this.getNodeChildrenCell(parentNode);
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
    const editingNode = this.getNodeByPath(this.editingNodePath!);
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
          const editingNode = this.getNodeByPath(this.editingNodePath!);
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

    const focusedNode = this.getNodeByPath(this.focusedNodePath);
    if (!focusedNode) {
      console.warn("Focused node no longer exists");
      return;
    }

    const context = EventUtils.createKeyboardContext(
      event,
      this,
      focusedNode,
    );

    executeKeyboardCommand(event.key, context);
  }

  private finishEditingAndCreateNew() {
    if (!this.editingNodePath) return;

    this.finishEditing();

    if (this.focusedNodePath) {
      const focusedNode = this.getNodeByPath(this.focusedNodePath);
      if (focusedNode) {
        this.createNewNodeAfter(focusedNode);
      }
    }
  }

  /**
   * Create a new sibling node after the specified node
   *
   * @param node - The node to create a sibling after
   * @description Creates an empty node as a sibling after the given node,
   * focuses it, and immediately enters edit mode. Uses Cell operations.
   */
  async createNewNodeAfter(node: OutlineTreeNode) {
    if (!this.value) return;

    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) return;

    const nodeIndex = TreeOperations.getNodeIndex(parentNode, node);
    const newNode = TreeOperations.createNode({ body: "" });

    // Calculate the expected path for the new node before mutation
    const parentPath = this.getNodePath(parentNode);
    if (!parentPath) return;
    
    const newNodePath = [...parentPath, nodeIndex + 1]; // Insert after current node

    const parentChildrenCell = this.getNodeChildrenCell(parentNode);
    if (parentChildrenCell) {
      await mutateCell(parentChildrenCell, (cell) => {
        const currentChildren = cell.get();
        const beforeNode = currentChildren.slice(0, nodeIndex + 1);
        const afterNode = currentChildren.slice(nodeIndex + 1);
        const newChildren = [...beforeNode, newNode, ...afterNode];
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
      const newNodeFromTree = this.getNodeByPath(newNodePath);
      if (newNodeFromTree) {
        const nodeIndex = this.getNodeIndex(newNodeFromTree);
        OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
      }
    }, 0);
  }

  /**
   * Create a new child node under the specified node
   *
   * @param node - The parent node to create a child under
   * @description Creates an empty node as the first child of the given node,
   * focuses it, and immediately enters edit mode. Uses Cell operations.
   */
  async createChildNode(node: OutlineTreeNode) {
    if (!this.value) return;

    const newNode = TreeOperations.createNode({ body: "" });

    // Calculate the expected path for the new child node before mutation
    const parentPath = this.getNodePath(node);
    if (parentPath === null) return;
    
    const newNodePath = [...parentPath, 0]; // Insert as first child

    const nodeChildrenCell = this.getNodeChildrenCell(node);
    if (nodeChildrenCell) {
      await mutateCell(nodeChildrenCell, (cell) => {
        const currentChildren = cell.get();
        const newChildren = [newNode, ...currentChildren];
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
      const newNodeFromTree = this.getNodeByPath(newNodePath);
      if (newNodeFromTree) {
        const nodeIndex = this.getNodeIndex(newNodeFromTree);
        OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
      }
    }, 0);
  }

  startEditingWithInitialText(node: OutlineTreeNode, initialText: string) {
    if (this.readonly) return;
    const path = this.getNodePath(node);
    if (!path) return;

    this.editingNodePath = path;
    this.editingContent = initialText; // Replace entire content with initial text
    this.requestUpdate();
    const nodeIndex = this.getNodeIndex(node);
    // Focus the editor and select all text so typing replaces content
    OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
  }

  async deleteNode(node: OutlineTreeNode) {
    if (!this.value) return;

    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) {
      console.error("Cannot delete root node");
      return;
    }

    const nodeIndex = TreeOperations.getNodeIndex(parentNode, node);
    if (nodeIndex === -1) {
      console.error("Node not found in parent");
      return;
    }

    const parentChildrenCell = this.getNodeChildrenCell(parentNode);
    if (parentChildrenCell) {
      await mutateCell(parentChildrenCell, (cell) => {
        const currentChildren = cell.get();
        const beforeNode = currentChildren.slice(0, nodeIndex);
        const afterNode = currentChildren.slice(nodeIndex + 1);

        // Move children up to parent level if any, otherwise just remove
        let newChildren: OutlineTreeNode[];
        if (node.children.length > 0) {
          const childrenCopies = node.children.map((child) =>
            this.createNodeCopy(child)
          );
          newChildren = [...beforeNode, ...childrenCopies, ...afterNode];
        } else {
          newChildren = [...beforeNode, ...afterNode];
        }

        cell.set(newChildren);
      });
    }

    // Determine new focus using existing logic
    const newFocusNode = TreeOperations.determineFocusAfterDeletion(
      this.tree,
      parentNode,
      nodeIndex,
    );

    if (newFocusNode) {
      this.focusedNodePath = this.getNodePath(newFocusNode);
    } else {
      this.focusedNodePath = null;
    }
    this.requestUpdate();

    if (this.focusedNodePath) {
      OutlinerEffects.focusOutliner(this.shadowRoot);
    }
  }

  async indentNode(node: OutlineTreeNode) {
    if (!this.value) return;

    // Preserve editing state if this node is being edited
    const nodePath = this.getNodePath(node);
    const wasEditing = this.editingNodePath && nodePath &&
      this.editingNodePath.length === nodePath.length &&
      this.editingNodePath.every((val, idx) => val === nodePath[idx]);
    const editingContent = wasEditing ? this.editingContent : "";

    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) {
      console.error("Cannot indent node: node has no parent");
      return;
    }

    const nodeIndex = parentNode.children.indexOf(node);
    if (nodeIndex <= 0) {
      console.error("Cannot indent first child node");
      return;
    }

    const previousSibling = parentNode.children[nodeIndex - 1];
    const parentChildrenCell = this.getNodeChildrenCell(parentNode);
    const siblingChildrenCell = this.getNodeChildrenCell(previousSibling);

    if (parentChildrenCell && siblingChildrenCell) {
      // V-DOM style: precise mutations using single transaction
      const tx = this.value.runtime.edit();

      // Remove from current parent
      const currentParentChildren = parentChildrenCell.get();
      const newParentChildren = currentParentChildren.filter((child) =>
        child !== node
      );
      parentChildrenCell.withTx(tx).set(newParentChildren);

      // Add to previous sibling's children
      const currentSiblingChildren = siblingChildrenCell.get();
      const nodeCopy = this.createNodeCopy(node);
      siblingChildrenCell.withTx(tx).set([...currentSiblingChildren, nodeCopy]);

      await tx.commit();
    }

    // Restore editing state if it was being edited
    if (wasEditing) {
      // Node reference no longer used - path stored above
      this.editingContent = editingContent;
    }

    this.requestUpdate();
  }

  indentNodeWithEditState(
    node: OutlineTreeNode,
    editingContent: string,
    cursorPosition: number,
  ) {
    // Store editing state before indent
    const nodePath = this.getNodePath(node);
    if (!nodePath) return;

    const wasEditing = this.editingNodePath &&
      this.editingNodePath.length === nodePath.length &&
      this.editingNodePath.every((val, idx) => val === nodePath[idx]);

    this.editingNodePath = nodePath;
    this.editingContent = editingContent;

    // Perform indent using migrated method
    this.indentNode(node);

    // Restore focus and cursor position after re-render
    setTimeout(() => {
      const nodeIndex = this.getNodeIndex(node);
      const editor = this.shadowRoot?.querySelector(
        `#editor-${nodeIndex}`,
      ) as HTMLTextAreaElement;
      if (editor) {
        editor.value = editingContent;
        editor.focus();
        editor.setSelectionRange(cursorPosition, cursorPosition);
      }
    }, 0);
  }

  async outdentNode(node: OutlineTreeNode) {
    if (!this.value) return;

    // Preserve editing state if this node is being edited
    const nodePath = this.getNodePath(node);
    const wasEditing = this.editingNodePath && nodePath &&
      this.editingNodePath.length === nodePath.length &&
      this.editingNodePath.every((val, idx) => val === nodePath[idx]);
    const editingContent = wasEditing ? this.editingContent : "";

    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) {
      console.error("Cannot outdent node: node has no parent");
      return;
    }

    const grandParentNode = TreeOperations.findParentNode(
      this.tree.root,
      parentNode,
    );
    if (!grandParentNode) {
      console.error("Cannot outdent node: already at root level");
      return;
    }

    const nodeIndex = parentNode.children.indexOf(node);
    const parentIndex = grandParentNode.children.indexOf(parentNode);

    if (nodeIndex === -1 || parentIndex === -1) {
      console.error("Node structure is inconsistent");
      return;
    }

    const parentChildrenCell = this.getNodeChildrenCell(parentNode);
    const grandParentChildrenCell = this.getNodeChildrenCell(grandParentNode);

    if (parentChildrenCell && grandParentChildrenCell) {
      // V-DOM style: precise mutations using single transaction
      const tx = this.value.runtime.edit();

      // Remove from current parent
      const currentParentChildren = parentChildrenCell.get();
      const newParentChildren = currentParentChildren.filter((child) =>
        child !== node
      );
      parentChildrenCell.withTx(tx).set(newParentChildren);

      // Add to grandparent after parent
      const currentGrandParentChildren = grandParentChildrenCell.get();
      const beforeParent = currentGrandParentChildren.slice(0, parentIndex + 1);
      const afterParent = currentGrandParentChildren.slice(parentIndex + 1);
      const nodeCopy = this.createNodeCopy(node);
      const newGrandParentChildren = [
        ...beforeParent,
        nodeCopy,
        ...afterParent,
      ];
      grandParentChildrenCell.withTx(tx).set(newGrandParentChildren);

      await tx.commit();
    }

    // Restore editing state if it was being edited
    if (wasEditing) {
      // Node reference no longer used - path stored above
      this.editingContent = editingContent;
    }

    this.requestUpdate();
  }

  outdentNodeWithEditState(
    node: OutlineTreeNode,
    editingContent: string,
    cursorPosition: number,
  ) {
    // Store editing state before outdent
    const nodePath = this.getNodePath(node);
    if (!nodePath) return;

    this.editingNodePath = nodePath;
    this.editingContent = editingContent;

    // Perform outdent using migrated method
    this.outdentNode(node);

    // Restore focus and cursor position after re-render
    setTimeout(() => {
      const nodeIndex = this.getNodeIndex(node);
      const editor = this.shadowRoot?.querySelector(
        `#editor-${nodeIndex}`,
      ) as HTMLTextAreaElement;
      if (editor) {
        editor.value = editingContent;
        editor.focus();
        editor.setSelectionRange(cursorPosition, cursorPosition);
      }
    }, 0);
  }

  moveNodeUp(node: OutlineTreeNode) {
    if (!this.value) return;

    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) {
      return; // Cannot move node up: node has no parent
    }

    const childIndex = parentNode.children.indexOf(node);
    if (childIndex <= 0) {
      return; // Cannot move node up: already at first position
    }

    const parentChildrenCell = this.getNodeChildrenCell(parentNode);
    if (parentChildrenCell) {
      // V-DOM style: swap positions directly
      mutateCell(parentChildrenCell, (cell) => {
        const currentChildren = cell.get();
        const newChildren = [...currentChildren];

        // Swap the node with the previous one
        [newChildren[childIndex - 1], newChildren[childIndex]] = [
          newChildren[childIndex],
          newChildren[childIndex - 1],
        ];

        cell.set(newChildren);
      });
    }

    this.requestUpdate();
  }

  moveNodeDown(node: OutlineTreeNode) {
    if (!this.value) return;

    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) {
      return; // Cannot move node down: node has no parent
    }

    const childIndex = parentNode.children.indexOf(node);
    if (childIndex === -1 || childIndex >= parentNode.children.length - 1) {
      return; // Cannot move node down: already at last position
    }

    const parentChildrenCell = this.getNodeChildrenCell(parentNode);
    if (parentChildrenCell) {
      // V-DOM style: swap positions directly
      mutateCell(parentChildrenCell, (cell) => {
        const currentChildren = cell.get();
        const newChildren = [...currentChildren];

        // Swap the node with the next one
        [newChildren[childIndex], newChildren[childIndex + 1]] = [
          newChildren[childIndex + 1],
          newChildren[childIndex],
        ];

        cell.set(newChildren);
      });
    }

    this.requestUpdate();
  }

  private deleteCurrentNode() {
    if (!this.editingNodePath) return;

    this.cancelEditing();
    // Use the migrated deleteNode method
    if (this.focusedNodePath) {
      const focusedNode = this.getNodeByPath(this.focusedNodePath);
      if (focusedNode) {
        this.deleteNode(focusedNode);
      }
    }
  }

  private mergeWithNextNode() {
    if (!this.editingNodePath) return;

    const editingNode = this.getNodeByPath(this.editingNodePath);
    if (!editingNode) return;

    const allNodes = this.getAllNodes();
    const currentIndex = allNodes.indexOf(editingNode);

    if (currentIndex === -1 || currentIndex >= allNodes.length - 1) return;

    const nextNode = allNodes[currentIndex + 1];
    const mergedContent = this.editingContent + nextNode.body;
    const cursorPosition = this.editingContent.length;

    // Update current node with merged content
    this.editingContent = mergedContent;
    this.finishEditing();

    // Delete the next node using the migrated method
    this.deleteNode(nextNode);

    // Re-enter editing mode at the merge point
    this.startEditing(this.focusedNode!);
    const nodeIndex = this.getNodeIndex(this.focusedNode!);
    OutlinerEffects.setCursorPosition(
      this.shadowRoot,
      nodeIndex,
      cursorPosition,
    );
  }

  private handleIndentation(shiftKey: boolean) {
    if (!this.editingNodePath) return;

    this.finishEditing();

    if (shiftKey) {
      // Outdent - use migrated method
      this.outdentNode(this.focusedNode!);
    } else {
      // Indent - use migrated method
      this.indentNode(this.focusedNode!);
    }

    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  private getFilteredMentions(): Charm[] {
    if (!this.mentionable || this.mentionable.get().length === 0) return [];

    const query = this.mentionQuery.toLowerCase();
    const matches = [];

    const flattened = this.mentionable.get();
    for (const mention of flattened) {
      if (mention[NAME]?.toLowerCase()?.includes(query)) {
        matches.push(flattened.indexOf(mention));
      }
    }

    return matches.map((i) => this.mentionable.key(i).getAsQueryResult());
  }

  private async insertMention(mention: Charm) {
    if (!this.editingNodePath) return;

    const editingNode = this.getNodeByPath(this.editingNodePath);
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
    const flattened = this.mentionable.get() || [];
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
  private handleCheckboxChange(node: OutlineTreeNode, event: Event) {
    const checkbox = event.target as HTMLInputElement;
    const isChecked = checkbox.checked;

    // Update the node's body to match the checkbox state
    this.setNodeCheckbox(node, isChecked);
  }

  /**
   * Set checkbox state on a node to a specific boolean value using Cell operations
   */
  setNodeCheckbox(node: OutlineTreeNode, isChecked: boolean) {
    if (!this.value) return;

    const nodeBodyCell = this.getNodeBodyCell(node);
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

  /**
   * Toggle checkbox state on a node (for keyboard shortcuts)
   */
  toggleNodeCheckbox(node: OutlineTreeNode) {
    // Read current checkbox state from Cell if available, otherwise from node
    let currentState: boolean;
    const nodeBodyCell = this.getNodeBodyCell(node);
    if (nodeBodyCell) {
      // Use current Cell value (not potentially stale node.body)
      const currentBody = nodeBodyCell.get();
      currentState = TreeOperations.isCheckboxChecked({
        body: currentBody,
        children: [],
        attachments: [],
      });
    } else {
      // Fallback to reading from node directly
      currentState = TreeOperations.isCheckboxChecked(node);
    }

    this.setNodeCheckbox(node, !currentState);
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
        const newNodeFromTree = this.getNodeByPath(newNodePath);
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
      const focusedNode = this.getNodeByPath(this.focusedNodePath);
      if (!focusedNode) return;

      const parentNode = TreeOperations.findParentNode(
        this.tree.root,
        focusedNode,
      );

      if (parentNode) {
        const nodeIndex = TreeOperations.getNodeIndex(
          parentNode,
          focusedNode,
        );

        // Insert all parsed nodes after the focused node using Cell operations
        const parentChildrenCell = this.getNodeChildrenCell(parentNode);
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
        const parentPath = this.getNodePath(parentNode);
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
        : this.renderNodes(this.tree.root.children, 0, [])}
        </div>
      </div>
    `;
  }

  private renderNodes(
    nodes: readonly OutlineTreeNode[],
    level: number,
    parentPath: number[] = [],
  ): unknown {
    return repeat(
      nodes,
      (node) => this.getNodeIndex(node),
      (node, index) => this.renderNode(node, level, [...parentPath, index]),
    );
  }

  private renderNode(node: OutlineTreeNode, level: number, calculatedPath: number[]): unknown {
    // Defensive check for corrupted nodes
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) {
      console.error("Corrupted node in renderNode:", node);
      return html`
        <div class="error">Corrupted node</div>
      `;
    }

    // Use calculated path from renderNodes instead of getNodePath to avoid timing issues
    const nodePath = calculatedPath;

    const hasChildren = node.children.length > 0;

    // Check if this node is being edited
    const isEditing = this.editingNodePath &&
      this.editingNodePath.length === nodePath.length &&
      this.editingNodePath.every((val, idx) => val === nodePath[idx]);

    // Check if this node is focused
    const isFocused = this.focusedNodePath &&
      this.focusedNodePath.length === nodePath.length &&
      this.focusedNodePath.every((val, idx) => val === nodePath[idx]);

    const isCollapsed = this._collapsedNodePaths.has(
      this.pathToString(nodePath),
    );
    const nodeIndex = this.getNodeIndex(node);

    return html`
      <div class="node" style="position: relative;">
        <div
          class="node-content ${isFocused ? "focused" : ""} ${isEditing
        ? "editing"
        : ""}"
          @click="${(e: MouseEvent) => this.handleNodeClick(node, e)}"
          @dblclick="${(e: MouseEvent) => this.handleNodeDoubleClick(node, e)}"
        >
          <div
            class="collapse-icon ${isCollapsed ? "collapsed" : ""} ${hasChildren
        ? ""
        : "invisible"}"
            @click="${(e: MouseEvent) => this.handleCollapseClick(node, e)}"
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
        : this.renderMarkdownContent(node.body, node)}
          </div>
        </div>

        ${this.renderAttachments(node)} ${hasChildren && !isCollapsed
        ? html`
          <div class="children">
            ${this.renderNodes(node.children, level + 1, nodePath)}
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

    const editingNode = this.getNodeByPath(this.editingNodePath);
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

  private getCharmDisplayText(charm: any): string {
    if (!charm) return "";

    // Try to get a meaningful identifier from the charm
    if (typeof charm === "string") return charm;
    if (charm.id) return charm.id;
    if (charm._id) return charm._id;
    if (charm.charmId) return charm.charmId;
    if (charm.title) return `"${charm.title}"`;

    // Fallback to a truncated JSON representation
    try {
      const str = JSON.stringify(charm);
      return str.length > 40 ? str.substring(0, 40) + "..." : str;
    } catch {
      return "[Object]";
    }
  }

  private renderMarkdownContent(
    content: string,
    node: OutlineTreeNode,
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
              @change="${(e: Event) => {
            e.stopPropagation();
            this.handleCheckboxChange(node, e);
          }}"
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
   * Get the path through the tree structure to reach a specific node
   * @param targetNode The node to find the path to
   * @returns Array representing the path through the tree structure, e.g. ['root', 'children', 0, 'children', 0]
   */
  private getTreeStructurePath(
    targetNode: OutlineTreeNode,
  ): (string | number)[] | null {
    const findStructurePath = (
      node: OutlineTreeNode,
      currentPath: (string | number)[],
    ): (string | number)[] | null => {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const childPath = [...currentPath, "children", i];

        if (child === targetNode) {
          return childPath;
        }

        const result = findStructurePath(child, childPath);
        if (result) {
          return result;
        }
      }
      return null;
    };

    return findStructurePath(this.tree.root, ["root"]);
  }

  /**
   * Render attachments for a node using ct-render
   */
  private renderAttachments(node: OutlineTreeNode): unknown {
    if (!node.attachments || node.attachments.length === 0) {
      return "";
    }

    if (!isCell(this.value)) {
      return "";
    }

    const tree: Cell<Tree> = this.value;
    const runtime = tree.runtime;
    const space = tree.space;

    // Create proper charm cell references from attachment charm objects
    const charmCells = node.attachments.map((attachment) => {
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
        ${charmCells.map((charmCell) => {
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
