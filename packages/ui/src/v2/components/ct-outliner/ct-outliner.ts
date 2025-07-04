import { css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { BaseElement } from "../../core/base-element.ts";
import { marked } from "marked";

import type {
  CharmReference,
  EditingState,
  KeyboardContext,
  EditingKeyboardContext,
  MentionableItem,
  Tree,
  Node as OutlineTreeNode,
} from "./types.ts";
import { executeKeyboardCommand, executeEditingKeyboardCommand } from "./keyboard-commands.ts";
import { TreeOperations } from "./tree-operations.ts";

/**
 * CTOutliner - An outliner component with hierarchical tree structure
 *
 * @element ct-outliner
 *
 * @attr {Tree} value - Tree structure with root node
 * @attr {boolean} readonly - Whether the outliner is read-only
 * @attr {Array} mentionable - Array of mentionable items with {name, charm} structure
 *
 * @fires ct-change - Fired when content changes with detail: { value }
 * @fires charm-link-click - Fired when a charm link is clicked with detail: { href, text, charm }
 *
 * @example
 * const tree = { root: { body: "", children: [{ body: "Item 1", children: [], attachments: [] }] } };
 * <ct-outliner .value=${tree}></ct-outliner>
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

  declare value: Tree;
  declare readonly: boolean;
  declare mentionable: MentionableItem[];
  declare tree: Tree;
  declare collapsedNodes: Set<OutlineTreeNode>;
  declare focusedNode: OutlineTreeNode | null;
  declare showingMentions: boolean;
  declare mentionQuery: string;
  declare selectedMentionIndex: number;

  private editingNode: OutlineTreeNode | null = null;
  private editingContent: string = "";
  private _internalChange = false;
  
  // Cache node indices for editor IDs
  private nodeIndexMap = new WeakMap<OutlineTreeNode, number>();
  private nodeCounter = 0;

  // Test helpers - expose some internal state for testing
  get _testHelpers() {
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
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1),
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
  `;

  constructor() {
    super();
    this.readonly = false;
    this.mentionable = [];
    this.tree = TreeOperations.createEmptyTree();
    this.collapsedNodes = new Set<OutlineTreeNode>();
    this.focusedNode = null;
    this.showingMentions = false;
    this.mentionQuery = "";
    this.selectedMentionIndex = 0;
    this.value = this.tree;
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

    if (changedProperties.has("value") && !this.editingNode) {
      // Don't update tree from value if we're internally managing it
      // This prevents focus loss when we programmatically update the value
      if (!this._internalChange) {
        this.tree = this.value;
        // Reset focus if the focused node no longer exists
        if (this.focusedNode && !TreeOperations.findNode(this.tree.root, this.focusedNode)) {
          this.focusedNode = this.tree.root.children[0] || null;
        }
      }
    }
  }

  private getNodeIndex(node: OutlineTreeNode): number {
    if (!this.nodeIndexMap.has(node)) {
      this.nodeIndexMap.set(node, this.nodeCounter++);
    }
    return this.nodeIndexMap.get(node)!;
  }

  private getAllNodes(): OutlineTreeNode[] {
    return TreeOperations.getAllNodes(this.tree.root).slice(1); // Skip root
  }

  private getAllVisibleNodes(): OutlineTreeNode[] {
    return TreeOperations.getAllVisibleNodes(this.tree.root, this.collapsedNodes);
  }

  emitChange() {
    this._internalChange = true;
    this.value = this.tree;
    this._internalChange = false;
    this.emit("ct-change", { value: this.tree });
  }

  /**
   * Export the current tree content as markdown string
   */
  toMarkdown(): string {
    return TreeOperations.toMarkdown(this.tree);
  }

  startEditing(node: OutlineTreeNode) {
    if (this.readonly) return;
    this.editingNode = node;
    this.editingContent = node.body;
    this.requestUpdate();
    const nodeIndex = this.getNodeIndex(node);
    OutlinerEffects.focusEditor(this.shadowRoot, nodeIndex);
  }

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

  private finishEditing() {
    if (!this.editingNode) return;
    
    // Tree is mutated in place, no need to reassign
    TreeOperations.updateNodeBody(this.tree, this.editingNode, this.editingContent);
    this.focusedNode = this.editingNode;
    this.editingNode = null;
    this.editingContent = "";
    this.requestUpdate();
    this.emitChange();
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
    const lines = pastedText.split("\n").filter(line => line.trim());
    if (lines.length === 0) return;
    
    // Update current node with first line
    const target = event.target as HTMLTextAreaElement;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const newContent = 
      this.editingContent.substring(0, start) + 
      lines[0] + 
      this.editingContent.substring(end);
    
    this.editingContent = newContent;
    target.value = newContent;
    
    // Create new nodes for remaining lines
    if (lines.length > 1) {
      this.finishEditing();
      
      const parentNode = TreeOperations.findParentNode(this.tree.root, this.focusedNode!);
      if (parentNode) {
        const nodeIndex = TreeOperations.getNodeIndex(parentNode, this.focusedNode!);
        
        // Insert new nodes after current one
        for (let i = 1; i < lines.length; i++) {
          const newNode = TreeOperations.createNode({ body: lines[i] });
          this.tree = TreeOperations.insertNode(this.tree, parentNode, newNode, nodeIndex + i);
        }
        
        this.emitChange();
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
    const editingContext: EditingKeyboardContext = {
      event,
      component: this,
      editingNode: this.editingNode!,
      editingContent: this.editingContent,
      textarea: target,
    };

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

    const allNodes = this.getAllVisibleNodes();
    const currentIndex = this.focusedNode ? allNodes.indexOf(this.focusedNode) : -1;

    const context: KeyboardContext = {
      event,
      component: this,
      allNodes,
      currentIndex,
      focusedNode: this.focusedNode,
    };

    executeKeyboardCommand(event.key, context);
  }

  private finishEditingAndCreateNew() {
    if (!this.editingNode) return;
    
    this.finishEditing();
    this.createNewNodeAfter(this.focusedNode!);
  }

  createNewNodeAfter(node: OutlineTreeNode) {
    const parentNode = TreeOperations.findParentNode(this.tree.root, node);
    if (!parentNode) return;
    
    const nodeIndex = TreeOperations.getNodeIndex(parentNode, node);
    const newNode = TreeOperations.createNode({ body: "" });
    
    // Tree is mutated in place, no need to reassign
    TreeOperations.insertNode(this.tree, parentNode, newNode, nodeIndex + 1);
    this.focusedNode = newNode;
    this.requestUpdate();
    this.emitChange();
    this.startEditing(newNode);
  }

  createChildNode(node: OutlineTreeNode) {
    const newNode = TreeOperations.createNode({ body: "" });
    
    // Insert as first child of the current node - tree is mutated in place
    TreeOperations.insertNode(this.tree, node, newNode, 0);
    this.focusedNode = newNode;
    this.requestUpdate();
    this.emitChange();
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
    const result = TreeOperations.deleteNode(this.tree, node);
    if (result.success) {
      // Tree is mutated in place, no need to reassign
      this.focusedNode = result.newFocusNode;
      this.requestUpdate();
      this.emitChange();
      
      if (this.focusedNode) {
        OutlinerEffects.focusOutliner(this.shadowRoot);
      }
    }
  }

  indentNode(node: OutlineTreeNode) {
    // Preserve editing state if this node is being edited
    const wasEditing = this.editingNode === node;
    const editingContent = wasEditing ? this.editingContent : "";
    
    const result = TreeOperations.indentNode(this.tree, node);
    if (result.success) {
      // Tree is mutated in place, no need to reassign
      
      // Restore editing state if it was being edited
      if (wasEditing) {
        this.editingNode = node;
        this.editingContent = editingContent;
      }
      
      this.requestUpdate();
      this.emitChange();
    }
  }

  outdentNode(node: OutlineTreeNode) {
    // Preserve editing state if this node is being edited
    const wasEditing = this.editingNode === node;
    const editingContent = wasEditing ? this.editingContent : "";
    
    const result = TreeOperations.outdentNode(this.tree, node);
    if (result.success) {
      // Tree is mutated in place, no need to reassign
      
      // Restore editing state if it was being edited
      if (wasEditing) {
        this.editingNode = node;
        this.editingContent = editingContent;
      }
      
      this.requestUpdate();
      this.emitChange();
    }
  }

  private deleteCurrentNode() {
    if (!this.editingNode) return;
    
    this.cancelEditing();
    const result = TreeOperations.deleteNode(this.tree, this.focusedNode!);
    
    if (result.success) {
      // Tree is mutated in place, no need to reassign
      this.focusedNode = result.newFocusNode;
      this.requestUpdate();
      this.emitChange();
      
      if (this.focusedNode) {
        OutlinerEffects.focusOutliner(this.shadowRoot);
      }
    }
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
    
    // Delete the next node
    const result = TreeOperations.deleteNode(this.tree, nextNode);
    if (result.success) {
      // Tree is mutated in place, no need to reassign
      this.requestUpdate();
      this.emitChange();
      
      // Re-enter editing mode at the merge point
      this.startEditing(this.focusedNode!);
      const nodeIndex = this.getNodeIndex(this.focusedNode!);
      OutlinerEffects.setCursorPosition(this.shadowRoot, nodeIndex, cursorPosition);
    }
  }

  private handleIndentation(shiftKey: boolean) {
    if (!this.editingNode) return;
    
    this.finishEditing();
    
    if (shiftKey) {
      // Outdent
      const result = TreeOperations.outdentNode(this.tree, this.focusedNode!);
      if (result.success) {
        this.tree = result.tree;
        this.emitChange();
      }
    } else {
      // Indent
      const result = TreeOperations.indentNode(this.tree, this.focusedNode!);
      if (result.success) {
        this.tree = result.tree;
        this.emitChange();
      }
    }
    
    this.requestUpdate();
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

  private encodeCharmForHref(charm: CharmReference): string {
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

  private decodeCharmFromHref(
    href: string | null,
  ): CharmReference | string | null {
    if (!href) return null;

    try {
      // Decode the URL-encoded charm representation
      const decoded = decodeURIComponent(href);

      // Try to parse it back if it looks like JSON
      if (decoded.startsWith("{") && decoded.endsWith("}")) {
        return JSON.parse(decoded);
      }

      // Otherwise return the decoded string
      return decoded;
    } catch (error) {
      // If decoding/parsing fails, return the original href
      return href;
    }
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
    if (target.matches(".placeholder") && (!this.tree || this.tree.root.children.length === 0)) {
      event.preventDefault();
      
      // Create new node
      const newNode = TreeOperations.createNode({ body: "" });
      
      this.tree = {
        ...this.tree,
        root: { ...this.tree.root, children: [newNode] }
      };
      
      this.focusedNode = newNode;
      this.requestUpdate();
      this.emitChange();
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
      const parentNode = TreeOperations.findParentNode(this.tree.root, this.focusedNode);
      
      if (parentNode) {
        const nodeIndex = TreeOperations.getNodeIndex(parentNode, this.focusedNode);
        
        // Insert all parsed nodes after the focused node
        let currentTree = this.tree;
        parsedTree.root.children.forEach((node, index) => {
          currentTree = TreeOperations.insertNode(currentTree, parentNode, node, nodeIndex + 1 + index);
        });
        
        this.tree = currentTree;
        
        // Focus the first newly inserted node
        this.focusedNode = parsedTree.root.children[0];
      }
    } else if (this.tree.root.children.length === 0) {
      // No nodes exist, replace root children
      this.tree = {
        root: {
          ...this.tree.root,
          children: parsedTree.root.children
        }
      };
      this.focusedNode = parsedTree.root.children[0];
    } else {
      // No focused node but tree has nodes, append to the end
      this.tree = {
        root: {
          ...this.tree.root,
          children: [...this.tree.root.children, ...parsedTree.root.children]
        }
      };
      this.focusedNode = parsedTree.root.children[0];
    }

    this.requestUpdate();
    this.emitChange();
  }

  override render() {
    const hasNodes = this.tree && this.tree.root.children.length > 0;
    
    return html`
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
    `;
  }

  private renderNodes(nodes: readonly OutlineTreeNode[], level: number): unknown {
    return repeat(
      nodes,
      (node) => this.getNodeIndex(node),
      (node) => this.renderNode(node, level),
    );
  }

  private renderNode(node: OutlineTreeNode, level: number): unknown {
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
          @dblclick="${(e: MouseEvent) =>
        this.handleNodeDoubleClick(node, e)}"
        >
          <div
            class="collapse-icon ${isCollapsed ? "collapsed" : ""} ${hasChildren ? "" : "invisible"}"
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
        return `<a href="${href}" class="charm-link"${titleAttr}>${text}</a>`;
      };

      const html_content = marked.parse(content, {
        renderer,
        breaks: false,
        gfm: true,
      });

      return html`
        <span class="markdown-content">${unsafeHTML(html_content)}</span>
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