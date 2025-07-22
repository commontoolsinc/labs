import { css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { BaseElement } from "../../core/base-element.ts";
import { marked } from "marked";
import {
  type CellController,
  createCellController,
} from "../../core/cell-controller.ts";
import { type Cell, isCell } from "@commontools/runner";

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
import { Charm } from "@commontools/charm";

/**
 * CTOutliner - An outliner component with hierarchical tree structure
 *
 * Uses CellController for reactive state management. When value is a Cell<Tree>,
 * operations automatically propagate changes. When value is a plain Tree object,
 * falls back to manual change events.
 *
 * @element ct-outliner
 *
 * @attr {Tree | Cell<Tree>} value - Tree structure with root node or Cell containing tree
 * @attr {boolean} readonly - Whether the outliner is read-only
 * @attr {Array} mentionable - Array of mentionable items with {name, charm} structure
 *
 * @fires ct-change - Fired when content changes with detail: { value }
 * @fires charm-link-click - Fired when a charm link is clicked with detail: { href, text, charm }
 *
 * @example
 * // With plain tree object
 * const tree = { root: { body: "", children: [{ body: "Item 1", children: [], attachments: [] }] } };
 * <ct-outliner .value=${tree}></ct-outliner>
 *
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
    collapsedNodes: { type: Object, state: true },
    focusedNode: { type: Object, state: true },
    showingMentions: { type: Boolean, state: true },
    mentionQuery: { type: String, state: true },
    selectedMentionIndex: { type: Number, state: true },
  };

  declare value: Tree | Cell<Tree>;
  declare readonly: boolean;
  declare mentionable: MentionableItem[];
  // Backward compatibility getter/setter for tree access
  get tree(): Tree {
    return this.cellController.getValue();
  }

  set tree(newTree: Tree) {
    // Always bind to ensure we have a Cell for transactions
    // This is safe to call multiple times
    this.cellController.bind(newTree);
  }
  declare collapsedNodes: Set<OutlineTreeNode>;
  declare focusedNode: OutlineTreeNode | null;
  declare showingMentions: boolean;
  declare mentionQuery: string;
  declare selectedMentionIndex: number;

  private editingNode: OutlineTreeNode | null = null;
  private editingContent: string = "";
  private cellController: CellController<Tree>;

  // Node indexer for stable DOM element IDs
  private nodeIndexer = NodeUtils.createNodeIndexer();

  // Test API - expose internal state for testing
  get testAPI() {
    return {
      editingNode: this.editingNode,
      editingContent: this.editingContent,
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
  `;

  constructor() {
    super();
    this.readonly = false;
    this.collapsedNodes = new Set<OutlineTreeNode>();
    this.focusedNode = null;
    this.showingMentions = false;
    this.mentionQuery = "";
    this.selectedMentionIndex = 0;

    // Initialize with empty tree
    this.value = TreeOperations.createEmptyTree();

    // Initialize CellController with immediate timing for tree updates
    this.cellController = createCellController<Tree>(this, {
      timing: { strategy: "immediate" },
      onChange: (newTree, oldTree) => {
        this.emit("ct-change", { value: newTree });
        // Handle focus restoration after tree changes
        this.focusedNode = FocusUtils.findValidFocus(newTree, this.focusedNode);
      },
    });

    // Bind the initial value to the CellController
    this.cellController.bind(this.value);
  }

  override connectedCallback() {
    super.connectedCallback();
    // Only initialize if tree is empty
    if (!this.tree || this.tree.root.children.length === 0) {
      // Initialize with empty tree if no value provided
      if (!this.value) {
        this.value = TreeOperations.createEmptyTree();
      }
      // Set initial focus to first node if we have nodes
      if (this.tree.root.children.length > 0 && !this.focusedNode) {
        this.focusedNode = this.tree.root.children[0];
      }
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    // Bind CellController to new value when value property changes
    if (changedProperties.has("value")) {
      this.cellController.bind(this.value);
    }
  }

  private getNodeIndex(node: OutlineTreeNode): number {
    return this.nodeIndexer.getIndex(node);
  }

  /**
   * Deep clone a single node and all its children
   */
  private deepCloneNode(node: OutlineTreeNode): OutlineTreeNode {
    const cloned: OutlineTreeNode = {
      body: node.body || "",
      children: [],
      attachments: node.attachments ? [...node.attachments] : [],
    };

    // Clone children if they exist and are valid
    if (node.children && Array.isArray(node.children)) {
      cloned.children = node.children.map((child) => this.deepCloneNode(child));
    }

    return cloned;
  }

  // =============================================================================
  // Cell Path Navigation Utilities
  // =============================================================================

  /**
   * Get the path to a node as an array of indices from root.children
   */
  private getNodePath(targetNode: OutlineTreeNode): number[] | null {
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
   * Convert a node path (array of indices) to a Cell key path
   */
  private getNodeCellPath(node: OutlineTreeNode): string[] | null {
    const nodePath = this.getNodePath(node);
    if (!nodePath) return null;

    // Convert [0, 2, 1] to ["root", "children", "0", "children", "2", "children", "1"]
    const cellPath = ["root", "children"];
    for (let i = 0; i < nodePath.length; i++) {
      cellPath.push(String(nodePath[i]));
      if (i < nodePath.length - 1) {
        cellPath.push("children");
      }
    }
    return cellPath;
  }

  /**
   * Get the Cell for a specific node in the tree
   * @param node The target node to get a Cell for
   * @returns Cell<Node> pointing to the node, or null if not found
   */
  private getNodeCell(node: OutlineTreeNode): Cell<OutlineTreeNode> | null {
    const rootCell = this.cellController.getCell();
    const cellPath = this.getNodeCellPath(node);

    if (!rootCell || !cellPath) return null;

    let targetCell: Cell<any> = rootCell;
    for (const key of cellPath) {
      targetCell = targetCell.key(key);
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
   * Execute a Cell transaction with proper error handling and change emission
   * If working with a plain object (not a Cell), fall back to direct mutations and emitChange()
   * @param cellOperation Function that performs Cell operations within the transaction
   * @param fallbackOperation Optional function for direct mutations when no Cell is available
   */
  private executeTransaction(
    cellOperation: (tx: any) => void,
    fallbackOperation?: () => void,
    operationName: string = "unknown",
  ): void {
    try {
      const rootCell = this.cellController.getCell();
      if (rootCell) {
        // We have a Cell - use transactions
        const tx = rootCell.runtime.edit();
        cellOperation(tx);
        tx.commit();
        // CellController handles change propagation automatically
      } else {
        // We have a plain object - use fallback or execute with null tx
        if (fallbackOperation) {
          fallbackOperation();
        } else {
          cellOperation(null); // Pass null to indicate no transaction
        }
        this.emitChange();
      }
    } catch (error) {
      console.error(`[${operationName}] Transaction failed:`, error);
    }
  }

  private getAllNodes(): OutlineTreeNode[] {
    return NodeUtils.getAllNodesExcludingRoot(this.tree);
  }

  getAllVisibleNodes(): OutlineTreeNode[] {
    return NodeUtils.getVisibleNodes(this.tree, this.collapsedNodes);
  }

  emitChange() {
    // Update the value property and let CellController handle change emission
    this.value = this.tree;
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
    this.editingNode = node;
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

    if (this.editingNode === node) {
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
   * Uses Cell operations when available, otherwise falls back to direct mutations.
   */
  finishEditing() {
    if (!this.editingNode) return;

    // Use Cell operations or fallback to direct mutation
    this.executeTransaction((tx) => {
      if (tx) {
        // Cell-based operation
        const nodeBodyCell = this.getNodeBodyCell(this.editingNode!);
        if (nodeBodyCell) {
          nodeBodyCell.withTx(tx).set(this.editingContent);
        }
      } else {
        // Direct mutation fallback
        TreeOperations.updateNodeBody(
          this.tree,
          this.editingNode!,
          this.editingContent,
        );
      }
    });

    this.focusedNode = this.editingNode;
    this.editingNode = null;
    this.editingContent = "";
    this.requestUpdate();
    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  private cancelEditing() {
    if (!this.editingNode) return;

    this.focusedNode = this.editingNode;
    this.editingNode = null;
    this.editingContent = "";
    this.requestUpdate();
    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  private handleNodeClick(node: OutlineTreeNode, event: MouseEvent) {
    if (this.readonly) return;
    event.stopPropagation();

    if (this.editingNode && this.editingNode !== node) {
      this.finishEditing();
    }

    this.focusedNode = node;
    this.requestUpdate();
  }

  private handleNodeDoubleClick(node: OutlineTreeNode, event: MouseEvent) {
    if (this.readonly) return;
    event.stopPropagation();
    this.startEditing(node);
  }

  private handleCollapseClick(node: OutlineTreeNode, event: MouseEvent) {
    event.stopPropagation();

    if (this.collapsedNodes.has(node)) {
      this.collapsedNodes.delete(node);
    } else {
      this.collapsedNodes.add(node);
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
      if (this.editingNode && !this.showingMentions) {
        this.finishEditing();
      }
    }, 200);
  }

  private handleEditorPaste(event: ClipboardEvent) {
    if (!this.editingNode) return;

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
        this.executeTransaction((tx) => {
          const parentChildrenCell = this.getNodeChildrenCell(parentNode);
          if (parentChildrenCell) {
            const currentChildren = parentChildrenCell.get();
            const newChildren = [...currentChildren];

            // Insert all new nodes at once
            for (let i = 1; i < lines.length; i++) {
              const newNode = TreeOperations.createNode({ body: lines[i] });
              newChildren.splice(nodeIndex + i, 0, newNode);
            }

            parentChildrenCell.withTx(tx).set(newChildren);
          }
        });
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
    const editingContext = EventUtils.createEditingKeyboardContext(
      event,
      this,
      this.editingNode!,
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
          const currentNodeIndex = allNodes.indexOf(this.editingNode!);
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
    if (this.readonly || this.editingNode) return;

    // Ensure we have a focused node before proceeding
    if (!this.focusedNode) {
      console.warn("No focused node available for keyboard command");
      return;
    }

    const context = EventUtils.createKeyboardContext(
      event,
      this,
      this.focusedNode,
    );

    executeKeyboardCommand(event.key, context);
  }

  private finishEditingAndCreateNew() {
    if (!this.editingNode) return;

    this.finishEditing();
    this.createNewNodeAfter(this.focusedNode!);
  }

  /**
   * Create a new sibling node after the specified node
   *
   * @param node - The node to create a sibling after
   * @description Creates an empty node as a sibling after the given node,
   * focuses it, and immediately enters edit mode. Uses Cell operations when available.
   */
  createNewNodeAfter(node: OutlineTreeNode) {
    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) return;

    const nodeIndex = TreeOperations.getNodeIndex(parentNode, node);
    const newNode = TreeOperations.createNode({ body: "" });

    // Use Cell operations with fallback to direct mutation
    this.executeTransaction(
      (tx) => {
        // Cell-based operation
        const parentChildrenCell = this.getNodeChildrenCell(parentNode);
        if (parentChildrenCell) {
          const currentChildren = parentChildrenCell.get();
          const newChildren = [...currentChildren];
          newChildren.splice(nodeIndex + 1, 0, newNode);
          parentChildrenCell.withTx(tx).set(newChildren);
        }
      },
      () => {
        // Direct mutation fallback
        TreeOperations.insertNode(
          this.tree,
          parentNode,
          newNode,
          nodeIndex + 1,
        );
      },
      "createNewNodeAfter",
    );

    this.focusedNode = newNode;
    this.requestUpdate();
    this.startEditing(newNode);
  }

  /**
   * Create a new child node under the specified node
   *
   * @param node - The parent node to create a child under
   * @description Creates an empty node as the first child of the given node,
   * focuses it, and immediately enters edit mode. Uses Cell operations when available.
   */
  createChildNode(node: OutlineTreeNode) {
    const newNode = TreeOperations.createNode({ body: "" });

    // Use Cell operations with fallback to direct mutation
    this.executeTransaction(
      (tx) => {
        // Cell-based operation
        const nodeChildrenCell = this.getNodeChildrenCell(node);
        if (nodeChildrenCell) {
          const currentChildren = nodeChildrenCell.get();
          const newChildren = [newNode, ...currentChildren];
          nodeChildrenCell.withTx(tx).set(newChildren);
        }
      },
      () => {
        // Direct mutation fallback
        TreeOperations.insertNode(this.tree, node, newNode, 0);
      },
    );

    this.focusedNode = newNode;
    this.requestUpdate();
    this.startEditing(newNode);
  }

  startEditingWithInitialText(node: OutlineTreeNode, initialText: string) {
    if (this.readonly) return;
    this.editingNode = node;
    this.editingContent = initialText; // Replace entire content with initial text
    this.requestUpdate();
    const nodeIndex = this.getNodeIndex(node);
    // Focus the editor and select all text so typing replaces content
    OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
  }

  deleteNode(node: OutlineTreeNode) {
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

    // Use Cell operations with fallback to TreeOperations
    this.executeTransaction(
      (tx) => {
        // Cell-based operation
        const parentChildrenCell = this.getNodeChildrenCell(parentNode);
        if (parentChildrenCell) {
          const currentChildren = parentChildrenCell.get();
          const newChildren = [...currentChildren];

          // Move children up to parent level if any, otherwise just remove
          if (node.children.length > 0) {
            newChildren.splice(nodeIndex, 1, ...node.children);
          } else {
            newChildren.splice(nodeIndex, 1);
          }

          parentChildrenCell.withTx(tx).set(newChildren);
        }
      },
      () => {
        // Direct mutation fallback
        TreeOperations.deleteNode(this.tree, node);
      },
    );

    // Determine new focus using existing logic
    const newFocusNode = TreeOperations.determineFocusAfterDeletion(
      this.tree,
      parentNode,
      nodeIndex,
    );

    this.focusedNode = newFocusNode;
    this.requestUpdate();

    if (this.focusedNode) {
      OutlinerEffects.focusOutliner(this.shadowRoot);
    }
  }

  indentNode(node: OutlineTreeNode) {
    // Preserve editing state if this node is being edited
    const wasEditing = this.editingNode === node;
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

    // Use Cell operations when CellController is active
    const rootCell = this.cellController.getCell();
    if (rootCell) {
      // COPY-DELETE-ADD approach to avoid Cell reference issues
      this.executeTransaction(
        (tx) => {
          const parentChildrenCell = this.getNodeChildrenCell(parentNode);
          const siblingChildrenCell = this.getNodeChildrenCell(previousSibling);

          if (parentChildrenCell && siblingChildrenCell) {
            // Step 1: Create a deep copy of the node to move
            const nodeCopy = this.deepCloneNode(node);

            // Step 2: Remove from current parent
            const currentParentChildren = parentChildrenCell.get();
            const newParentChildren = currentParentChildren.filter((child) =>
              child !== node
            );
            parentChildrenCell.withTx(tx).set(newParentChildren);

            // Step 3: Add copy to previous sibling's children
            const currentSiblingChildren = siblingChildrenCell.get();
            const newSiblingChildren = [...currentSiblingChildren, nodeCopy];
            siblingChildrenCell.withTx(tx).set(newSiblingChildren);

            // Step 4: Update focus to the new copy
            if (this.focusedNode === node) {
              this.focusedNode = nodeCopy;
            }
            if (this.editingNode === node) {
              this.editingNode = nodeCopy;
            }
          }
        },
        undefined, // No fallback to avoid mixed mutations
        "indentNode",
      );
    } else {
      // Only use TreeOperations when CellController is completely unavailable
      TreeOperations.indentNode(this.tree, node);
      this.emitChange();
    }

    // Restore editing state if it was being edited
    // Note: focus has already been updated to the new copy inside the transaction for Cell operations
    if (wasEditing) {
      if (rootCell) {
        // For Cell operations, editingNode was already updated to the copy
        this.editingContent = editingContent;
      } else {
        // For TreeOperations fallback, update to the same node
        this.editingNode = node;
        this.editingContent = editingContent;
      }
    }

    this.requestUpdate();
  }

  indentNodeWithEditState(
    node: OutlineTreeNode,
    editingContent: string,
    cursorPosition: number,
  ) {
    // Store editing state before indent
    const wasEditing = this.editingNode === node;
    this.editingNode = node;
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

  outdentNode(node: OutlineTreeNode) {
    // Preserve editing state if this node is being edited
    const wasEditing = this.editingNode === node;
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

    // Use Cell operations when CellController is active
    const rootCell = this.cellController.getCell();
    if (rootCell) {
      // COPY-DELETE-ADD approach to avoid Cell reference issues
      this.executeTransaction(
        (tx) => {
          const parentChildrenCell = this.getNodeChildrenCell(parentNode);
          const grandParentChildrenCell = this.getNodeChildrenCell(
            grandParentNode,
          );

          if (parentChildrenCell && grandParentChildrenCell) {
            // Step 1: Create a deep copy of the node to move
            const nodeCopy = this.deepCloneNode(node);

            // Step 2: Remove from current parent
            const currentParentChildren = parentChildrenCell.get();
            const newParentChildren = currentParentChildren.filter((child) =>
              child !== node
            );
            parentChildrenCell.withTx(tx).set(newParentChildren);

            // Step 3: Add copy to grandparent after parent
            const currentGrandParentChildren = grandParentChildrenCell.get();
            const newGrandParentChildren = [...currentGrandParentChildren];
            newGrandParentChildren.splice(parentIndex + 1, 0, nodeCopy);
            grandParentChildrenCell.withTx(tx).set(newGrandParentChildren);

            // Step 4: Update focus to the new copy
            if (this.focusedNode === node) {
              this.focusedNode = nodeCopy;
            }
            if (this.editingNode === node) {
              this.editingNode = nodeCopy;
            }
          }
        },
        undefined, // No fallback to avoid mixed mutations
        "outdentNode",
      );
    } else {
      // Only use TreeOperations when CellController is completely unavailable
      TreeOperations.outdentNode(this.tree, node);
      this.emitChange();
    }

    // Restore editing state if it was being edited
    // Note: focus has already been updated to the new copy inside the transaction for Cell operations
    if (wasEditing) {
      if (rootCell) {
        // For Cell operations, editingNode was already updated to the copy
        this.editingContent = editingContent;
      } else {
        // For TreeOperations fallback, update to the same node
        this.editingNode = node;
        this.editingContent = editingContent;
      }
    }

    this.requestUpdate();
  }

  outdentNodeWithEditState(
    node: OutlineTreeNode,
    editingContent: string,
    cursorPosition: number,
  ) {
    // Store editing state before outdent
    this.editingNode = node;
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
    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) {
      return; // Cannot move node up: node has no parent
    }

    const childIndex = parentNode.children.indexOf(node);
    if (childIndex <= 0) {
      return; // Cannot move node up: already at first position
    }

    // Use Cell operations when CellController is active
    const rootCell = this.cellController.getCell();
    if (rootCell) {
      // COPY-DELETE-ADD approach to avoid Cell reference issues
      this.executeTransaction(
        (tx) => {
          const parentChildrenCell = this.getNodeChildrenCell(parentNode);
          if (parentChildrenCell) {
            const currentChildren = parentChildrenCell.get();
            const previousNode = currentChildren[childIndex - 1];

            // Step 1: Create copies of both nodes that need to swap positions
            const nodeCopy = this.deepCloneNode(node);
            const previousNodeCopy = this.deepCloneNode(previousNode);

            // Step 2: Build new children array with swapped positions
            const newChildren = [...currentChildren];
            newChildren[childIndex - 1] = nodeCopy; // Put current node in previous position
            newChildren[childIndex] = previousNodeCopy; // Put previous node in current position

            parentChildrenCell.withTx(tx).set(newChildren);

            // Step 3: Update focus to the new copy
            if (this.focusedNode === node) {
              this.focusedNode = nodeCopy;
            }
            if (this.editingNode === node) {
              this.editingNode = nodeCopy;
            }
          }
        },
        undefined, // No fallback to avoid mixed mutations
        "moveNodeUp",
      );
    } else {
      // Only use TreeOperations when CellController is completely unavailable
      TreeOperations.moveNodeUp(this.tree, node);
      this.emitChange();
    }

    this.requestUpdate();
  }

  moveNodeDown(node: OutlineTreeNode) {
    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) {
      return; // Cannot move node down: node has no parent
    }

    const childIndex = parentNode.children.indexOf(node);
    if (childIndex === -1 || childIndex >= parentNode.children.length - 1) {
      return; // Cannot move node down: already at last position
    }

    // Use Cell operations when CellController is active
    const rootCell = this.cellController.getCell();
    if (rootCell) {
      // COPY-DELETE-ADD approach to avoid Cell reference issues
      this.executeTransaction(
        (tx) => {
          const parentChildrenCell = this.getNodeChildrenCell(parentNode);
          if (parentChildrenCell) {
            const currentChildren = parentChildrenCell.get();
            const nextNode = currentChildren[childIndex + 1];

            // Step 1: Create copies of both nodes that need to swap positions
            const nodeCopy = this.deepCloneNode(node);
            const nextNodeCopy = this.deepCloneNode(nextNode);

            // Step 2: Build new children array with swapped positions
            const newChildren = [...currentChildren];
            newChildren[childIndex] = nextNodeCopy; // Put next node in current position
            newChildren[childIndex + 1] = nodeCopy; // Put current node in next position

            parentChildrenCell.withTx(tx).set(newChildren);

            // Step 3: Update focus to the new copy
            if (this.focusedNode === node) {
              this.focusedNode = nodeCopy;
            }
            if (this.editingNode === node) {
              this.editingNode = nodeCopy;
            }
          }
        },
        undefined, // No fallback to avoid mixed mutations
        "moveNodeDown",
      );
    } else {
      // Only use TreeOperations when CellController is completely unavailable
      TreeOperations.moveNodeDown(this.tree, node);
      this.emitChange();
    }

    this.requestUpdate();
  }

  private deleteCurrentNode() {
    if (!this.editingNode) return;

    this.cancelEditing();
    // Use the migrated deleteNode method
    this.deleteNode(this.focusedNode!);
  }

  private mergeWithNextNode() {
    if (!this.editingNode) return;

    const allNodes = this.getAllNodes();
    const currentIndex = allNodes.indexOf(this.editingNode);

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
    if (!this.editingNode) return;

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

  private getFilteredMentions(): MentionableItem[] {
    if (!this.mentionable || this.mentionable.length === 0) return [];

    const query = this.mentionQuery.toLowerCase();
    return this.mentionable.filter((item) =>
      item.name.toLowerCase().includes(query)
    );
  }

  private insertMention(mention: MentionableItem) {
    if (!this.editingNode) return;

    const textarea = this.shadowRoot?.querySelector(
      `#editor-${this.getNodeIndex(this.editingNode)}`,
    ) as HTMLTextAreaElement;

    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = this.editingContent.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex === -1) return;

    const beforeMention = this.editingContent.substring(0, lastAtIndex);
    const afterMention = this.editingContent.substring(cursorPos);

    // Create markdown link with encoded charm reference
    const charmHref = this.encodeCharmForHref(mention.charm);
    const mentionText = `[${mention.name}](${charmHref})`;

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

  private encodeCharmForHref(charm: Charm): string {
    // Try to get a meaningful identifier from the charm first
    if (typeof charm === "string") return charm;
    if (charm.id) return charm.id;
    if (charm._id) return charm._id;
    if (charm.charmId) return charm.charmId;

    // Use the same safe stringification function that handles circular references
    const seen = new WeakSet();

    function stringify(value: any, depth: number = 0): string {
      // Handle primitives
      if (value === null) return "null";
      if (value === undefined) return "undefined";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      if (typeof value === "function") return "[Function]";

      // Handle depth limit (keep it shallow for URLs)
      if (depth > 2) return "[Deep Object]";

      // Handle circular references
      if (typeof value === "object" && seen.has(value)) {
        return "[Circular]";
      }

      if (typeof value === "object") {
        seen.add(value);

        // For objects, try to find a meaningful representation
        if (value.title) return value.title;
        if (value.name) return value.name;
        if (value.id) return value.id;
        if (value._id) return value._id;

        // Fallback to a simple object representation
        const keys = Object.keys(value).slice(0, 2);
        if (keys.length === 0) return "[Empty Object]";

        const pairs = keys.map((key) => {
          try {
            return `${key}:${stringify(value[key], depth + 1)}`;
          } catch (e) {
            return `${key}:[Error]`;
          }
        });

        return `{${pairs.join(",")}}`;
      }

      return "[Unknown]";
    }

    try {
      const result = stringify(charm);
      // Ensure the result is URL-safe by encoding special characters
      return encodeURIComponent(result);
    } catch (error) {
      return "[Stringify Error]";
    }
  }

  /**
   * Decode charm reference from href
   */
  private decodeCharmFromHref(href: string | null): Charm | null {
    if (!href) return null;
    try {
      // First try to decode URL encoding
      const decoded = decodeURIComponent(href);

      // Try to find the original charm reference from mentionable items
      for (const mention of this.mentionable) {
        const encodedHref = this.encodeCharmForHref(mention.charm);
        if (encodedHref === href) {
          return mention.charm;
        }
      }

      // If decoded content looks like an ID, use it directly
      if (decoded && typeof decoded === "string") {
        return { id: decoded };
      }

      // Fallback: treat href as simple ID
      return { id: href };
    } catch (error) {
      // Fallback: treat href as simple ID
      return { id: href };
    }
  }

  /**
   * Handle click on charm links
   */
  private handleCharmLinkClick(event: MouseEvent) {
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

    const charm = this.decodeCharmFromHref(href);
    if (!charm) {
      return;
    }

    // Emit the charm-link-click event
    this.emit("charm-link-click", {
      href,
      text: text || "",
    });
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

      this.executeTransaction((tx) => {
        const rootChildrenCell = this.cellController.getCell()?.key("root").key(
          "children",
        ) as Cell<OutlineTreeNode[]>;
        if (rootChildrenCell) {
          rootChildrenCell.withTx(tx).set([newNode]);
        }
      });

      this.focusedNode = newNode;
      this.requestUpdate();
      this.startEditing(newNode);
    }
  }

  private handleOutlinerPaste(event: ClipboardEvent) {
    // Only handle paste when not editing
    if (this.editingNode || this.readonly) return;

    const pastedText = event.clipboardData?.getData("text/plain");
    if (!pastedText) return;

    event.preventDefault();

    // Parse the pasted markdown into a tree structure
    const parsedTree = TreeOperations.parseMarkdownToTree(pastedText);

    if (parsedTree.root.children.length === 0) return;

    if (this.focusedNode) {
      const parentNode = TreeOperations.findParentNode(
        this.tree.root,
        this.focusedNode,
      );

      if (parentNode) {
        const nodeIndex = TreeOperations.getNodeIndex(
          parentNode,
          this.focusedNode,
        );

        // Insert all parsed nodes after the focused node using Cell operations
        this.executeTransaction((tx) => {
          const parentChildrenCell = this.getNodeChildrenCell(parentNode);
          if (parentChildrenCell) {
            const currentChildren = parentChildrenCell.get();
            const newChildren = [...currentChildren];

            // Insert all parsed nodes at once
            parsedTree.root.children.forEach((node, index) => {
              newChildren.splice(nodeIndex + 1 + index, 0, node);
            });

            parentChildrenCell.withTx(tx).set(newChildren);
          }
        });

        // Focus the first newly inserted node
        this.focusedNode = parsedTree.root.children[0];
      }
    } else if (this.tree.root.children.length === 0) {
      // No nodes exist, replace root children using Cell operations
      this.executeTransaction((tx) => {
        const rootChildrenCell = this.cellController.getCell()?.key("root").key(
          "children",
        ) as Cell<OutlineTreeNode[]>;
        if (rootChildrenCell) {
          rootChildrenCell.withTx(tx).set(parsedTree.root.children);
        }
      });
      this.focusedNode = parsedTree.root.children[0];
    } else {
      // No focused node but tree has nodes, append to the end using Cell operations
      this.executeTransaction((tx) => {
        const rootChildrenCell = this.cellController.getCell()?.key("root").key(
          "children",
        ) as Cell<OutlineTreeNode[]>;
        if (rootChildrenCell) {
          const currentChildren = rootChildrenCell.get();
          const newChildren = [...currentChildren, ...parsedTree.root.children];
          rootChildrenCell.withTx(tx).set(newChildren);
        }
      });
      this.focusedNode = parsedTree.root.children[0];
    }

    this.requestUpdate();
  }

  override render() {
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
        : this.renderNodes(this.tree.root.children, 0)}
        </div>
      </div>
    `;
  }

  private renderNodes(
    nodes: readonly OutlineTreeNode[],
    level: number,
  ): unknown {
    return repeat(
      nodes,
      (node) => this.getNodeIndex(node),
      (node) => this.renderNode(node, level),
    );
  }

  private renderNode(node: OutlineTreeNode, level: number): unknown {
    // Defensive check for corrupted nodes
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) {
      console.error("Corrupted node in renderNode:", node);
      return html`
        <div class="error">Corrupted node</div>
      `;
    }

    const hasChildren = node.children.length > 0;
    const isEditing = this.editingNode === node;
    const isFocused = this.focusedNode === node;
    const isCollapsed = this.collapsedNodes.has(node);
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
        : this.renderMarkdownContent(node.body)}
          </div>
        </div>

        ${hasChildren && !isCollapsed
        ? html`
          <div class="children">
            ${this.renderNodes(node.children, level + 1)}
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

    // Calculate position relative to viewport for fixed positioning
    const editor = this.shadowRoot?.querySelector(
      `#editor-${this.getNodeIndex(this.editingNode!)}`,
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
            <div class="mention-name">${mention.name}</div>
            <div class="mention-charm">${this.getCharmDisplayText(
            mention.charm,
          )}</div>
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

  private renderMarkdownContent(content: string): unknown {
    if (!content.trim()) {
      return html`
        <span class="placeholder">Empty</span>
      `;
    }

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

      const html_content = marked.parse(content, {
        renderer,
        breaks: false,
        gfm: true,
      });

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
}

customElements.define("ct-outliner", CTOutliner);
