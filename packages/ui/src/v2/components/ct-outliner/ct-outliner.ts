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
  LegacyNodeCreationOptions,
  OutlineNode,
  Tree,
  Node as OutlineTreeNode,
  Block,
} from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";
import { executeKeyboardCommand, executeEditingKeyboardCommand } from "./keyboard-commands.ts";
import { EditingOperations } from "./editing-operations.ts";
import { MigrationBridge } from "./migration-bridge.ts";
import { BlockOperations } from "./block-operations.ts";

/**
 * CTOutliner - A block-based outliner component with hierarchical tree structure
 *
 * @element ct-outliner
 *
 * @attr {Tree} value - Tree structure with nodes and blocks
 * @attr {boolean} readonly - Whether the outliner is read-only
 * @attr {Array} mentionable - Array of mentionable items with {name, charm} structure
 *
 * @fires ct-change - Fired when content changes with detail: { value }
 * @fires charm-link-click - Fired when a charm link is clicked with detail: { href, text, charm }
 *
 * @example
 * const tree = { root: { id: "1", children: [] }, blocks: [{ id: "1", body: "Item 1", attachments: [] }], attachments: [] };
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
  focusEditor(shadowRoot: ShadowRoot | null, nodeId: string): void {
    if (!shadowRoot) return;

    setTimeout(() => {
      const editor = shadowRoot.querySelector(
        `#editor-${nodeId}`,
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
    nodeId: string,
    position: number,
  ): void {
    if (!shadowRoot) return;

    setTimeout(() => {
      const editor = shadowRoot.querySelector(
        `#editor-${nodeId}`,
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
    focusedNodeId: { type: String, state: true },
    showingMentions: { type: Boolean, state: true },
    mentionQuery: { type: String, state: true },
    selectedMentionIndex: { type: Number, state: true },
  };

  private _value: Tree | null = null;

  get value(): Tree | null {
    return this._value;
  }

  set value(newValue: Tree | null) {
    const oldValue = this._value;
    this._value = newValue;

    // Only update internal state if this is an external change
    if (!this._internalChange && oldValue !== newValue) {
      if (newValue) {
        this.tree = newValue;
        this.collapsedNodes = new Set<string>();
        
        // Convert tree to legacy nodes for compatibility during transition
        this.nodes = MigrationBridge.treeToLegacyNodes(newValue);
        
        // Maintain focus on first node if needed
        if (!this.focusedNodeId && this.nodes.length > 0) {
          this.focusedNodeId = this.nodes[0].id;
        }
      } else {
        this.tree = BlockOperations.createEmptyTree();
        this.collapsedNodes = new Set<string>();
        this.nodes = [this.createNode("", 0)];
        if (this.nodes.length > 0) {
          this.focusedNodeId = this.nodes[0].id;
        }
      }
    }

    this.requestUpdate("value", oldValue);
  }

  declare readonly: boolean;
  declare mentionable: MentionableItem[];
  declare tree: Tree;
  declare collapsedNodes: Set<string>;
  declare focusedNodeId: string | null;
  declare showingMentions: boolean;
  declare mentionQuery: string;
  declare selectedMentionIndex: number;

  // Legacy nodes property - keeping temporarily for gradual migration
  declare nodes: OutlineNode[];

  private editingNodeId: string | null = null;
  private editingContent: string = "";
  private _internalChange = false;

  // Test helpers - expose some internal state for testing
  get _testHelpers() {
    return {
      editingNodeId: this.editingNodeId,
      editingContent: this.editingContent,
      createNode: (content: string, level: number) =>
        this.createNode(content, level),
      nodesToMarkdown: (nodes: OutlineNode[]) => this.nodesToMarkdown(nodes),
      emitChange: () => this.emitChange(),
      startEditing: (nodeId: string) => this.startEditing(nodeId),
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

    .children {
      margin-left: var(--outliner-indent);
    }

    .children.collapsed {
      display: none;
    }

    .placeholder {
      color: var(--muted-foreground);
      font-style: italic;
    }

    .mentions-dropdown {
      position: fixed;
      background: var(--background);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      box-shadow:
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 10px 15px -3px rgba(0, 0, 0, 0.1);
      z-index: 9999;
      max-height: 12rem;
      overflow-y: auto;
      min-width: 12rem;
    }

    .mention-item {
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid var(--border);
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
      font-family: monospace;
    }

    .markdown-content {
      display: inline;
    }

    .markdown-content a {
      color: #2563eb;
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.2s;
    }

    .markdown-content a:hover {
      border-bottom-color: #2563eb;
    }

    .markdown-content a.charm-link {
      color: #7c3aed;
      font-weight: 500;
    }

    .markdown-content a.charm-link:hover {
      border-bottom-color: #7c3aed;
      background-color: rgba(124, 58, 237, 0.1);
      padding: 0 2px;
      border-radius: 2px;
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
      border-radius: 0.25rem;
      font-family: monospace;
      font-size: 0.875em;
    }
  `;

  constructor() {
    super();
    this.readonly = false;
    this.mentionable = [];
    this.tree = BlockOperations.createEmptyTree();
    this.collapsedNodes = new Set<string>();
    this.nodes = []; // Legacy property
    this.focusedNodeId = null;
    this.showingMentions = false;
    this.mentionQuery = "";
    this.selectedMentionIndex = 0;
    this.value = this.tree;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Only initialize nodes if they haven't been set yet
    if (!this.nodes || this.nodes.length === 0) {
      // Initialize with empty tree if no value provided
      if (!this.value) {
        this.value = BlockOperations.createEmptyTree();
      }
      // Set initial focus to first node if we have nodes
      if (this.nodes.length > 0 && !this.focusedNodeId) {
        this.focusedNodeId = this.nodes[0].id;
      }
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("value") && !this.editingNodeId) {
      // Don't update nodes from value if we're internally managing them
      // This prevents focus loss when we programmatically update the value
      return;
    }
  }

  private createNode(content: string, level: number): OutlineNode {
    return TreeOperations.createNode({ content, level });
  }

  /**
   * Helper methods for working with Tree structure
   */
  private findNodeInTree(nodeId: string): OutlineTreeNode | null {
    if (!this.tree) return null;
    return BlockOperations.findNode(this.tree.root, nodeId);
  }

  private findBlockInTree(blockId: string): Block | null {
    if (!this.tree) return null;
    return BlockOperations.findBlock(this.tree, blockId);
  }

  private getNodeContent(nodeId: string): string {
    const block = this.findBlockInTree(nodeId);
    return block?.body || "";
  }

  private updateNodeContent(nodeId: string, content: string): void {
    if (!this.tree) return;
    this.tree = BlockOperations.updateBlock(this.tree, nodeId, content);
    // Update legacy nodes for compatibility
    this.nodes = MigrationBridge.treeToLegacyNodes(this.tree);
  }

  private parseMarkdownToTree(markdown: string): Tree {
    if (!markdown.trim()) return BlockOperations.createEmptyTree();

    const lines = markdown.split("\n");
    const blocks: Block[] = [];
    const stack: { nodeId: string; level: number }[] = [];
    const nodeChildren: Map<string, string[]> = new Map();

    let rootNodeId: string | null = null;

    for (const line of lines) {
      const match = line.match(/^(\s*)-\s(.*)$/);
      if (!match) continue;

      const [, indent, content] = match;
      const level = Math.floor(indent.length / 2);
      const nodeId = BlockOperations.createId();
      
      // Create block for this content
      const block = BlockOperations.createBlock({ id: nodeId, body: content });
      blocks.push(block);

      // Remove items from stack that are at same or deeper level
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length === 0) {
        // This is a root level node
        if (rootNodeId === null) {
          rootNodeId = nodeId;
        }
      } else {
        // Add as child of the parent
        const parentId = stack[stack.length - 1].nodeId;
        if (!nodeChildren.has(parentId)) {
          nodeChildren.set(parentId, []);
        }
        nodeChildren.get(parentId)!.push(nodeId);
      }

      stack.push({ nodeId, level });
    }

    // Build the node tree
    const buildNode = (nodeId: string): OutlineTreeNode => {
      const children = nodeChildren.get(nodeId) || [];
      return {
        id: nodeId,
        children: children.map(buildNode),
      };
    };

    const root = rootNodeId ? buildNode(rootNodeId) : BlockOperations.createNode({ id: BlockOperations.createId() });

    return {
      root,
      blocks,
      attachments: [],
    };
  }

  // Legacy method for backward compatibility during transition
  private parseMarkdown(markdown: string): OutlineNode[] {
    const tree = this.parseMarkdownToTree(markdown);
    return MigrationBridge.treeToLegacyNodes(tree);
  }

  private nodesToMarkdown(nodes: OutlineNode[], baseLevel = 0): string {
    return nodes
      .map((node) => {
        const indent = "  ".repeat(node.level);
        const line = `${indent}- ${node.content}`;
        const childLines = node.children.length > 0
          ? "\n" + this.nodesToMarkdown(node.children, node.level + 1)
          : "";
        return line + childLines;
      })
      .join("\n");
  }

  findNode(id: string, nodes: OutlineNode[] = this.nodes): OutlineNode | null {
    return TreeOperations.findNode(nodes, id);
  }

  private findNodeParent(
    id: string,
    nodes: OutlineNode[] = this.nodes,
  ): OutlineNode[] | null {
    return TreeOperations.findNodeParent(nodes, id) as OutlineNode[] | null;
  }

  findParentNode(
    id: string,
    nodes: OutlineNode[] = this.nodes,
  ): OutlineNode | null {
    return TreeOperations.findParentNode(nodes, id);
  }

  private getNodeIndex(id: string, nodes: OutlineNode[]): number {
    return TreeOperations.getNodeIndex(nodes, id);
  }

  private getAllNodes(nodes: OutlineNode[] = this.nodes): OutlineNode[] {
    return TreeOperations.getAllVisibleNodes(nodes);
  }

  private handleNodeClick(nodeId: string, event: MouseEvent) {
    event.stopPropagation();
    if (!this.readonly && !this.editingNodeId) {
      this.focusedNodeId = nodeId;
    }
  }

  private handleNodeDoubleClick(nodeId: string, event: MouseEvent) {
    event.stopPropagation();
    if (!this.readonly) {
      this.startEditing(nodeId);
    }
  }

  private handleCollapseClick(nodeId: string, event: MouseEvent) {
    event.stopPropagation();
    const node = this.findNode(nodeId);
    if (node && node.children.length > 0) {
      node.collapsed = !node.collapsed;
      this.requestUpdate();
    }
  }

  startEditing(nodeId: string) {
    const node = this.findNode(nodeId);
    if (!node) return;

    // Pure data transformation - prepare editing state
    const editingState = EditingOperations.prepareEditingState(
      this.editingNodeId,
      this.editingContent,
      nodeId,
      node.content,
    );

    // Apply new state
    this.editingNodeId = editingState.editingNodeId;
    this.editingContent = editingState.editingContent;
    this.showingMentions = editingState.showingMentions;

    // Side effects
    this.requestUpdate();
    OutlinerEffects.focusEditor(this.shadowRoot, nodeId);
  }

  private finishEditing() {
    if (!this.editingNodeId) return;

    // Pure data transformation - update node content
    const result = EditingOperations.completeEdit(
      this.nodes,
      this.editingNodeId,
      this.editingContent,
    );

    if (!result.success) return;

    // Save node ID for focus before clearing editing state
    const nodeId = this.editingNodeId;

    // Pure data transformation - clear editing state
    const clearState = EditingOperations.clearEditingState();
    this.editingNodeId = clearState.editingNodeId;
    this.editingContent = clearState.editingContent;
    this.showingMentions = clearState.showingMentions;

    // Maintain focus on the node we just edited
    this.focusedNodeId = nodeId;

    // Side effects
    this.requestUpdate();
    this.emitChange(); // This will now include any indentation changes made during editing
    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  private cancelEditing() {
    if (this.editingNodeId) {
      const nodeId = this.editingNodeId;
      this.editingNodeId = null;
      this.editingContent = "";
      this.showingMentions = false;

      // Keep focus on the node we were editing
      this.focusedNodeId = nodeId;

      this.requestUpdate();

      // Restore focus to the outliner element for keyboard navigation
      setTimeout(() => {
        const outliner = this.shadowRoot?.querySelector(
          ".outliner",
        ) as HTMLElement;
        outliner?.focus();
      }, 0);
    }
  }

  private finishEditingAndCreateNew() {
    if (!this.editingNodeId) return;

    const currentNode = this.findNode(this.editingNodeId);
    if (!currentNode) return;

    // Update current node content
    currentNode.content = this.editingContent;

    // Find parent array and index
    const parentArray = this.findNodeParent(this.editingNodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(this.editingNodeId, parentArray);

    // Create new node - always at same level as current node
    const newNode = this.createNode("", currentNode.level);

    // Always insert after current node at the same level
    // This provides more predictable behavior
    parentArray.splice(currentIndex + 1, 0, newNode);

    // Clear editing state
    this.editingNodeId = null;
    this.editingContent = "";
    this.showingMentions = false;

    // Focus and start editing the new node
    this.focusedNodeId = newNode.id;
    this.requestUpdate();
    this.emitChange();

    // Start editing the new node after render
    setTimeout(() => {
      this.startEditing(newNode.id);
    }, 0);
  }

  private deleteCurrentNode() {
    if (!this.editingNodeId) return;

    const parentArray = this.findNodeParent(this.editingNodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(this.editingNodeId, parentArray);

    if (currentIndex === -1) return;

    // Don't delete if it's the only node
    if (this.nodes.length === 1 && this.nodes[0].children.length === 0) {
      return;
    }

    const nodeToDelete = parentArray[currentIndex];

    // Move children up to parent level if any
    if (nodeToDelete.children.length > 0) {
      const adjustedChildren = nodeToDelete.children.map((child) => ({
        ...child,
        level: nodeToDelete.level,
      }));
      parentArray.splice(currentIndex, 1, ...adjustedChildren);
    } else {
      parentArray.splice(currentIndex, 1);
    }

    // Clear editing state
    this.editingNodeId = null;
    this.editingContent = "";
    this.showingMentions = false;

    // Focus previous node or next node
    const allNodes = this.getAllNodes();

    // If no nodes remain, create a new root node
    if (allNodes.length === 0) {
      const newNode = this.createNode("", 0);
      this.nodes = [newNode];
      this.focusedNodeId = newNode.id;
      this.requestUpdate();
      this.emitChange();
      return;
    }

    const deletedIndex = allNodes.findIndex((n) => n.id === nodeToDelete.id);
    if (deletedIndex > 0) {
      this.focusedNodeId = allNodes[deletedIndex - 1].id;
    } else if (allNodes.length > 1) {
      this.focusedNodeId = allNodes[1].id;
    }

    this.requestUpdate();
    this.emitChange();
  }

  private mergeWithNextNode() {
    if (!this.editingNodeId) return;

    const allNodes = this.getAllNodes();
    const currentIndex = allNodes.findIndex((n) => n.id === this.editingNodeId);

    if (currentIndex === -1 || currentIndex >= allNodes.length - 1) return;

    const currentNode = allNodes[currentIndex];
    const nextNode = allNodes[currentIndex + 1];

    // Only merge if nodes are at the same level
    if (currentNode.level !== nextNode.level) return;

    // Store cursor position
    const cursorPos = this.editingContent.length;

    // Merge content
    currentNode.content = this.editingContent + nextNode.content;
    this.editingContent = currentNode.content;

    // Move next node's children to current node
    currentNode.children.push(...nextNode.children);

    // Delete the next node
    const nextParentArray = this.findNodeParent(nextNode.id) || this.nodes;
    const nextIndex = this.getNodeIndex(nextNode.id, nextParentArray);
    if (nextIndex !== -1) {
      nextParentArray.splice(nextIndex, 1);
    }

    // Update the editor and set cursor position
    this.requestUpdate();
    this.emitChange();

    setTimeout(() => {
      const editor = this.shadowRoot?.querySelector(
        `#editor-${this.editingNodeId}`,
      ) as HTMLTextAreaElement;
      if (editor) {
        editor.value = this.editingContent;
        editor.setSelectionRange(cursorPos, cursorPos);
        editor.focus();
      }
    }, 0);
  }

  private handleIndentation(outdent: boolean) {
    if (!this.editingNodeId) return;

    // Store the node ID and current editing state
    const nodeId = this.editingNodeId;
    const currentContent = this.editingContent;
    const textarea = this.shadowRoot?.querySelector(
      `#editor-${nodeId}`,
    ) as HTMLTextAreaElement;
    const cursorPos = textarea?.selectionStart || 0;

    // Perform the indentation without emitting changes
    const success = outdent 
      ? TreeOperations.outdentNode(this.nodes, this.editingNodeId)
      : TreeOperations.indentNode(this.nodes, this.editingNodeId);
    
    if (success) {
      // Only update the UI, don't emit change while editing
      this.requestUpdate();
      
      // Maintain edit mode after indentation
      this.editingNodeId = nodeId;
      this.editingContent = currentContent;

      // Restore focus/cursor position after render
      setTimeout(() => {
        const editor = this.shadowRoot?.querySelector(
          `#editor-${nodeId}`,
        ) as HTMLTextAreaElement;
        if (editor) {
          editor.value = currentContent;
          editor.setSelectionRange(cursorPos, cursorPos);
          editor.focus();
        }
      }, 0);
    }
  }

  private handleEditorInput(event: Event) {
    this.editingContent = (event.target as HTMLTextAreaElement).value;
    this.checkForMentions(event.target as HTMLTextAreaElement);
  }

  private handleEditorPaste(event: ClipboardEvent) {
    const pastedText = event.clipboardData?.getData("text/plain");
    if (!pastedText || !this.editingNodeId) return;

    // Check if pasted text contains markdown list items
    const lines = pastedText.split("\n");
    const listLines = lines.filter(line => line.match(/^(\s*)-\s(.+)$/));
    
    // If it's not a markdown list or just a single line, let default paste happen
    if (listLines.length <= 1) return;

    event.preventDefault();
    event.stopPropagation(); // Prevent the event from bubbling to the outliner container

    const currentNode = this.findNode(this.editingNodeId);
    if (!currentNode) return;

    // Parse the pasted markdown into nodes
    const parsedNodes = this.parseMarkdown(pastedText);
    if (parsedNodes.length === 0) return;

    // Get the parent array and current index
    const parentArray = this.findNodeParent(this.editingNodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(this.editingNodeId, parentArray);

    // If current node has content, update it with the first pasted node's content
    if (this.editingContent.trim()) {
      currentNode.content = this.editingContent + " " + parsedNodes[0].content;
    } else {
      currentNode.content = parsedNodes[0].content;
    }

    // Add first node's children to current node
    if (parsedNodes[0].children.length > 0) {
      // Adjust children levels to be relative to current node
      const adjustChildren = (children: OutlineNode[], baseLevel: number) => {
        children.forEach(child => {
          child.level = baseLevel + 1;
          if (child.children.length > 0) {
            adjustChildren(child.children, child.level);
          }
        });
      };
      adjustChildren(parsedNodes[0].children, currentNode.level);
      currentNode.children.push(...parsedNodes[0].children);
      currentNode.collapsed = false;
    }

    // Insert remaining nodes after the current node
    if (parsedNodes.length > 1) {
      const remainingNodes = parsedNodes.slice(1);
      // Adjust levels to match current node's level
      remainingNodes.forEach(node => {
        node.level = currentNode.level;
        TreeOperations.updateNodeLevels(node);
      });
      parentArray.splice(currentIndex + 1, 0, ...remainingNodes);
    }

    // Clear editing state and emit change
    this.editingNodeId = null;
    this.editingContent = "";
    this.showingMentions = false;
    this.focusedNodeId = currentNode.id;
    
    this.requestUpdate();
    this.emitChange();
    OutlinerEffects.focusOutliner(this.shadowRoot);
  }

  private handleEditorBlur = (event: FocusEvent) => {
    // If mentions are showing, delay the blur to allow clicking on mention items
    if (this.showingMentions) {
      setTimeout(() => {
        // Check if mentions are still showing after the delay
        // If the user clicked a mention, it will have been hidden by then
        if (this.showingMentions) {
          this.finishEditing();
        }
      }, 150);
    } else {
      // Check if the new focus target is within the outliner
      const relatedTarget = event.relatedTarget as HTMLElement;
      const outliner = this.shadowRoot?.querySelector(".outliner");

      // Only finish editing if focus is leaving the outliner entirely
      if (!outliner?.contains(relatedTarget)) {
        this.finishEditing();
      }
    }
  };

  private checkForMentions(textarea: HTMLTextAreaElement) {
    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = this.editingContent.substring(0, cursorPos);

    // Look for @ followed by text (but not preceded by alphanumeric)
    const mentionMatch = textBeforeCursor.match(
      /(?:^|[^a-zA-Z0-9])@([a-zA-Z0-9_]*)$/,
    );

    if (mentionMatch && this.mentionable && this.mentionable.length > 0) {
      this.mentionQuery = mentionMatch[1].toLowerCase();
      this.showingMentions = true;
      this.selectedMentionIndex = 0;
      this.requestUpdate();
    } else {
      this.showingMentions = false;
      this.requestUpdate();
    }
  }

  private getFilteredMentions() {
    if (!this.mentionable) return [];

    if (!this.mentionQuery) {
      return this.mentionable.slice(0, 10); // Show first 10 if no query
    }

    return this.mentionable
      .filter((item) => item.name.toLowerCase().includes(this.mentionQuery))
      .slice(0, 10);
  }

  private insertMention(mention: { name: string; charm: any }) {
    const textarea = this.shadowRoot?.querySelector(
      `#editor-${this.editingNodeId}`,
    ) as HTMLTextAreaElement;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = this.editingContent.substring(0, cursorPos);
    const textAfterCursor = this.editingContent.substring(cursorPos);

    // Find the @ symbol and replace from there
    const mentionMatch = textBeforeCursor.match(
      /(?:^|[^a-zA-Z0-9])@([a-zA-Z0-9_]*)$/,
    );
    if (mentionMatch) {
      const matchStart = textBeforeCursor.lastIndexOf("@");
      const beforeMention = this.editingContent.substring(0, matchStart);

      // Create markdown link with safe charm stringification
      const charmString = this.safeCharmStringify(mention.charm);
      const mentionText = `[${mention.name}](${charmString})`;

      this.editingContent = beforeMention + mentionText + textAfterCursor;

      // Update textarea and cursor position
      textarea.value = this.editingContent;
      const newCursorPos = beforeMention.length + mentionText.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }

    this.showingMentions = false;
    this.requestUpdate();
    textarea.focus();
  }

  private safeCharmStringify(charm: CharmReference): string {
    if (!charm) return "";

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
      editingNodeId: this.editingNodeId!,
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
          this.finishEditingAndCreateNew();
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
          const currentNodeIndex = allNodes.findIndex((n) =>
            n.id === this.editingNodeId
          );
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
    if (this.readonly || this.editingNodeId) return;

    const allNodes = this.getAllNodes();
    const currentIndex = allNodes.findIndex((node) =>
      node.id === this.focusedNodeId
    );

    const context: KeyboardContext = {
      event,
      component: this,
      allNodes,
      currentIndex,
      focusedNodeId: this.focusedNodeId,
    };

    executeKeyboardCommand(event.key, context);
  }

  private emitChange() {
    // Sync the tree with current legacy nodes (temporary during transition)
    if (this.nodes.length > 0) {
      this.tree = MigrationBridge.legacyNodesToTree(this.nodes);
    } else {
      this.tree = BlockOperations.createEmptyTree();
    }
    
    // Update value and emit change
    this._internalChange = true;
    this._value = this.tree;
    this._internalChange = false;
    this.emit("ct-change", { value: this.tree });
  }

  /**
   * Export the current tree content as markdown string
   * This provides a way to manually get markdown output for copy/export operations
   */
  toMarkdown(): string {
    return this.nodesToMarkdown(this.nodes);
  }

  createNewNodeAfter(nodeId: string) {
    const node = this.findNode(nodeId);
    if (!node) return;

    const parentArray = this.findNodeParent(nodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(nodeId, parentArray);

    const newNode = this.createNode("", node.level);
    parentArray.splice(currentIndex + 1, 0, newNode);

    this.focusedNodeId = newNode.id;
    this.requestUpdate();
    this.emitChange();

    setTimeout(() => {
      this.startEditing(newNode.id);
    }, 0);
  }

  createChildNode(nodeId: string) {
    const node = this.findNode(nodeId);
    if (!node) return;

    const newNode = this.createNode("", node.level + 1);
    node.children.push(newNode);

    // Ensure parent is expanded
    node.collapsed = false;

    this.focusedNodeId = newNode.id;
    this.requestUpdate();
    this.emitChange();

    setTimeout(() => {
      this.startEditing(newNode.id);
    }, 0);
  }

  deleteNode(nodeId: string) {
    const result = TreeOperations.deleteNode(this.nodes, nodeId);

    if (!result.success) return;

    // Handle focus after deletion
    if (result.newFocusId) {
      this.focusedNodeId = result.newFocusId;
    } else {
      // No nodes remain, create a new root node
      const newNode = this.createNode("", 0);
      this.nodes = [newNode];
      this.focusedNodeId = newNode.id;
    }

    this.requestUpdate();
    this.emitChange();
  }

  moveNodeUp(nodeId: string | null) {
    if (!nodeId) return;

    const success = TreeOperations.moveNodeUp(this.nodes, nodeId);
    if (success) {
      this.requestUpdate();
      this.emitChange();
    }
  }

  moveNodeDown(nodeId: string | null) {
    if (!nodeId) return;

    const success = TreeOperations.moveNodeDown(this.nodes, nodeId);
    if (success) {
      this.requestUpdate();
      this.emitChange();
    }
  }

  indentNode(nodeId: string) {
    const success = TreeOperations.indentNode(this.nodes, nodeId);
    if (success) {
      this.requestUpdate();
      this.emitChange();
    }
  }

  outdentNode(nodeId: string) {
    const success = TreeOperations.outdentNode(this.nodes, nodeId);
    if (success) {
      this.requestUpdate();
      this.emitChange();
    }
  }

  override render() {
    return html`
      <div
        class="outliner"
        @keydown="${this.handleKeyDown}"
        @click="${this.handleOutlinerClick}"
        @paste="${this.handleOutlinerPaste}"
        tabindex="0"
      >
        ${this.nodes.length === 0
        ? html`
          <div class="placeholder">Click to start typing...</div>
        `
        : this.renderNodes(this.nodes)}
      </div>
    `;
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
    if (target.matches(".placeholder") && this.nodes.length === 0) {
      event.preventDefault();
      this.nodes = [this.createNode("", 0)];
      this.focusedNodeId = this.nodes[0].id;
      this.startEditing(this.nodes[0].id);
      this.requestUpdate();
    }
  }

  private handleOutlinerPaste(event: ClipboardEvent) {
    // Only handle paste when not in edit mode (edit mode has its own paste handler)
    if (this.editingNodeId) return;

    const pastedText = event.clipboardData?.getData("text/plain");
    if (!pastedText) return;

    // Check if pasted text contains markdown list items
    const lines = pastedText.split("\n");
    const listLines = lines.filter(line => line.match(/^(\s*)-\s(.+)$/));
    
    // If it's not a markdown list or just a single line, ignore
    if (listLines.length <= 1) return;

    event.preventDefault();

    // Parse the pasted markdown into nodes
    const parsedNodes = this.parseMarkdown(pastedText);
    if (parsedNodes.length === 0) return;

    // If we have a focused node, insert after it
    if (this.focusedNodeId) {
      const focusedNode = this.findNode(this.focusedNodeId);
      if (focusedNode) {
        const parentArray = this.findNodeParent(this.focusedNodeId) || this.nodes;
        const currentIndex = this.getNodeIndex(this.focusedNodeId, parentArray);
        
        // Adjust levels to match the focused node's level
        parsedNodes.forEach(node => {
          node.level = focusedNode.level;
          TreeOperations.updateNodeLevels(node);
        });
        
        // Insert the parsed nodes after the focused node
        parentArray.splice(currentIndex + 1, 0, ...parsedNodes);
        
        // Focus the first newly inserted node
        this.focusedNodeId = parsedNodes[0].id;
      }
    } else {
      // No focused node, append to the end of root nodes
      this.nodes.push(...parsedNodes);
      this.focusedNodeId = parsedNodes[0].id;
    }

    this.requestUpdate();
    this.emitChange();
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

  private renderNodes(nodes: OutlineNode[]): unknown {
    return repeat(
      nodes,
      (node) => node.id,
      (node) => this.renderNode(node),
    );
  }

  private renderNode(node: OutlineNode): unknown {
    const hasChildren = node.children.length > 0;
    const isEditing = this.editingNodeId === node.id;
    const isFocused = this.focusedNodeId === node.id;

    return html`
      <div class="node" style="position: relative;">
        <div
          class="node-content ${isFocused ? "focused" : ""} ${isEditing
        ? "editing"
        : ""}"
          @click="${(e: MouseEvent) => this.handleNodeClick(node.id, e)}"
          @dblclick="${(e: MouseEvent) =>
        this.handleNodeDoubleClick(node.id, e)}"
        >
          <div
            class="collapse-icon ${node.collapsed ? "collapsed" : ""} ${hasChildren ? "" : "invisible"}"
            @click="${(e: MouseEvent) => this.handleCollapseClick(node.id, e)}"
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
            id="editor-${node.id}"
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
        : this.renderMarkdownContent(node.content)}
          </div>
        </div>

        ${hasChildren
        ? html`
          <div class="children ${node.collapsed ? "collapsed" : ""}">
            ${this.renderNodes(node.children)}
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
      `#editor-${this.editingNodeId}`,
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

globalThis.customElements.define("ct-outliner", CTOutliner);
