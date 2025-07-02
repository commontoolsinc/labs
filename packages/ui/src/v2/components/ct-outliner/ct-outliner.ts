import { css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { BaseElement } from "../../core/base-element.ts";
import { marked } from "marked";

/**
 * CTOutliner - An outliner component for hierarchical markdown bullet points
 *
 * @element ct-outliner
 *
 * @attr {string} value - Markdown content with bullet points
 * @attr {boolean} readonly - Whether the outliner is read-only
 * @attr {Array} mentionable - Array of mentionable items with {name, charm} structure
 *
 * @fires ct-change - Fired when content changes with detail: { value }
 * @fires charm-link-click - Fired when a charm link is clicked with detail: { href, text, charm }
 *
 * @example
 * <ct-outliner value="- Item 1\n  - Subitem 1\n  - Subitem 2\n- Item 2"></ct-outliner>
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
 * Core data structure for outline nodes, separate from UI state
 */
export interface OutlineNodeData {
  readonly id: string;
  readonly content: string;
  readonly children: readonly OutlineNodeData[];
  readonly level: number;
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

/**
 * Working interface that combines data and UI state for compatibility
 * TODO: Eventually migrate to use OutlineNodeData + OutlineUIState separately
 */
interface OutlineNode {
  id: string;
  content: string;
  children: OutlineNode[];
  collapsed: boolean;
  level: number;
}

/**
 * Pure functional operations for tree manipulation and traversal
 */
export const TreeOperations = {
  /**
   * Find a node by ID in a tree structure
   */
  findNode(nodes: readonly OutlineNode[], id: string): OutlineNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = TreeOperations.findNode(node.children, id);
      if (found) return found;
    }
    return null;
  },

  /**
   * Find the parent array containing a node with the given ID
   */
  findNodeParent(
    nodes: readonly OutlineNode[], 
    id: string, 
    parent: readonly OutlineNode[] | null = null
  ): readonly OutlineNode[] | null {
    for (const node of nodes) {
      if (node.id === id) return parent;
      const found = TreeOperations.findNodeParent(node.children, id, node.children);
      if (found) return found;
    }
    return null;
  },

  /**
   * Find the parent node (not array) containing a child with the given ID
   */
  findParentNode(nodes: readonly OutlineNode[], id: string): OutlineNode | null {
    for (const node of nodes) {
      if (node.children.some(child => child.id === id)) {
        return node;
      }
      const found = TreeOperations.findParentNode(node.children, id);
      if (found) return found;
    }
    return null;
  },

  /**
   * Get the index of a node in its parent array
   */
  getNodeIndex(nodes: readonly OutlineNode[], id: string): number {
    return nodes.findIndex(node => node.id === id);
  },

  /**
   * Get all visible nodes (respecting collapsed state) in depth-first order
   */
  getAllVisibleNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
    const result: OutlineNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (!node.collapsed) {
        result.push(...TreeOperations.getAllVisibleNodes(node.children));
      }
    }
    return result;
  },

  /**
   * Update the level of a node and all its descendants
   */
  updateNodeLevels(node: OutlineNode): void {
    const updateChildren = (children: OutlineNode[], parentLevel: number) => {
      for (const child of children) {
        child.level = parentLevel + 1;
        updateChildren(child.children, child.level);
      }
    };
    updateChildren(node.children, node.level);
  },

  /**
   * Create a new node with given content and level
   */
  createNode(content: string, level: number, nodeIdCounter: number): OutlineNode {
    return {
      id: `node-${nodeIdCounter}`,
      content,
      children: [],
      collapsed: false,
      level,
    };
  },

  /**
   * Move a node up among its siblings (returns new tree)
   */
  moveNodeUp(nodes: OutlineNode[], nodeId: string): { success: boolean; nodes: OutlineNode[] } {
    const parentArray = TreeOperations.findNodeParent(nodes, nodeId) || nodes;
    const currentIndex = TreeOperations.getNodeIndex(parentArray, nodeId);

    if (currentIndex <= 0) {
      return { success: false, nodes }; // Can't move up if first or not found
    }

    // Create new array with swapped positions
    const newParentArray = [...parentArray];
    const node = newParentArray[currentIndex];
    newParentArray.splice(currentIndex, 1);
    newParentArray.splice(currentIndex - 1, 0, node);

    return { success: true, nodes: [...nodes] }; // Return new tree reference
  },

  /**
   * Move a node down among its siblings (returns new tree)
   */
  moveNodeDown(nodes: OutlineNode[], nodeId: string): { success: boolean; nodes: OutlineNode[] } {
    const parentArray = TreeOperations.findNodeParent(nodes, nodeId) || nodes;
    const currentIndex = TreeOperations.getNodeIndex(parentArray, nodeId);

    if (currentIndex === -1 || currentIndex >= parentArray.length - 1) {
      return { success: false, nodes }; // Can't move down if last or not found
    }

    // Create new array with swapped positions
    const newParentArray = [...parentArray];
    const node = newParentArray[currentIndex];
    newParentArray.splice(currentIndex, 1);
    newParentArray.splice(currentIndex + 1, 0, node);

    return { success: true, nodes: [...nodes] }; // Return new tree reference
  },

  /**
   * Indent a node (make it a child of its previous sibling)
   */
  indentNode(nodes: OutlineNode[], nodeId: string): { success: boolean; nodes: OutlineNode[] } {
    const node = TreeOperations.findNode(nodes, nodeId);
    if (!node) return { success: false, nodes };

    const parentArray = TreeOperations.findNodeParent(nodes, nodeId) || nodes;
    const currentIndex = TreeOperations.getNodeIndex(parentArray, nodeId);

    if (currentIndex <= 0) {
      return { success: false, nodes }; // Cannot indent if first child or not found
    }

    // Get previous sibling
    const prevSibling = parentArray[currentIndex - 1];

    // Remove from current position and add as child of previous sibling
    const newParentArray = [...parentArray];
    newParentArray.splice(currentIndex, 1);
    
    prevSibling.children.push(node);
    node.level = prevSibling.level + 1;
    prevSibling.collapsed = false;

    // Update levels of all descendants
    TreeOperations.updateNodeLevels(node);

    return { success: true, nodes: [...nodes] }; // Return new tree reference
  },

  /**
   * Outdent a node (move it up one level in the hierarchy)
   */
  outdentNode(nodes: OutlineNode[], nodeId: string): { success: boolean; nodes: OutlineNode[] } {
    const node = TreeOperations.findNode(nodes, nodeId);
    if (!node) return { success: false, nodes };

    const parentNode = TreeOperations.findParentNode(nodes, nodeId);
    if (!parentNode) {
      return { success: false, nodes }; // Already at root level
    }

    const grandparentArray = TreeOperations.findNodeParent(nodes, parentNode.id) || nodes;
    const parentIndex = TreeOperations.getNodeIndex(grandparentArray, parentNode.id);
    const nodeIndex = TreeOperations.getNodeIndex(parentNode.children, nodeId);

    // Remove from current parent
    const newParentChildren = [...parentNode.children];
    newParentChildren.splice(nodeIndex, 1);
    parentNode.children = newParentChildren;

    // Insert after the parent in grandparent array
    const newGrandparentArray = [...grandparentArray];
    newGrandparentArray.splice(parentIndex + 1, 0, node);

    // Update level
    node.level = parentNode.level;

    // Update levels of all descendants
    TreeOperations.updateNodeLevels(node);

    return { success: true, nodes: [...nodes] }; // Return new tree reference
  }
};

/**
 * Command interface for keyboard actions
 */
interface KeyboardCommand {
  execute(context: KeyboardContext): void;
}

/**
 * Context object passed to keyboard commands
 */
interface KeyboardContext {
  readonly event: KeyboardEvent;
  readonly component: CTOutliner;
  readonly allNodes: OutlineNode[];
  readonly currentIndex: number;
  readonly focusedNodeId: string | null;
}

/**
 * Keyboard command implementations
 */
export const KeyboardCommands = {
  ArrowUp: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Up moves node up among siblings
        ctx.component.moveNodeUp(ctx.focusedNodeId);
      } else {
        if (ctx.currentIndex > 0) {
          ctx.component.focusedNodeId = ctx.allNodes[ctx.currentIndex - 1].id;
        } else if (ctx.currentIndex === -1 && ctx.allNodes.length > 0) {
          // If nothing is focused, start from the last node
          ctx.component.focusedNodeId = ctx.allNodes[ctx.allNodes.length - 1].id;
        }
      }
    }
  },

  ArrowDown: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Down moves node down among siblings
        ctx.component.moveNodeDown(ctx.focusedNodeId);
      } else {
        if (ctx.currentIndex < ctx.allNodes.length - 1) {
          ctx.component.focusedNodeId = ctx.allNodes[ctx.currentIndex + 1].id;
        } else if (ctx.currentIndex === -1 && ctx.allNodes.length > 0) {
          // If nothing is focused, start from the first node
          ctx.component.focusedNodeId = ctx.allNodes[0].id;
        }
      }
    }
  },

  ArrowLeft: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Left collapses current node
        if (ctx.focusedNodeId) {
          const node = ctx.component.findNode(ctx.focusedNodeId);
          if (node && node.children.length > 0) {
            node.collapsed = true;
            ctx.component.requestUpdate();
          }
        }
      } else {
        if (ctx.focusedNodeId) {
          const node = ctx.component.findNode(ctx.focusedNodeId);
          if (node) {
            if (node.children.length > 0 && !node.collapsed) {
              // Collapse node if expanded
              node.collapsed = true;
              ctx.component.requestUpdate();
            } else {
              // Move to parent if collapsed or leaf
              const parentNode = ctx.component.findParentNode(ctx.focusedNodeId);
              if (parentNode) {
                ctx.component.focusedNodeId = parentNode.id;
              }
            }
          }
        }
      }
    }
  },

  ArrowRight: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Right expands current node
        if (ctx.focusedNodeId) {
          const node = ctx.component.findNode(ctx.focusedNodeId);
          if (node && node.children.length > 0) {
            node.collapsed = false;
            ctx.component.requestUpdate();
          }
        }
      } else {
        if (ctx.focusedNodeId) {
          const node = ctx.component.findNode(ctx.focusedNodeId);
          if (node) {
            if (node.children.length > 0) {
              if (node.collapsed) {
                // Expand node if collapsed
                node.collapsed = false;
                ctx.component.requestUpdate();
              } else {
                // Move to first child if expanded
                ctx.component.focusedNodeId = node.children[0].id;
              }
            }
          }
        }
      }
    }
  },

  Home: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.allNodes.length > 0) {
        ctx.component.focusedNodeId = ctx.allNodes[0].id;
      }
    }
  },

  End: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.allNodes.length > 0) {
        ctx.component.focusedNodeId = ctx.allNodes[ctx.allNodes.length - 1].id;
      }
    }
  },

  Enter: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNodeId) {
        if (ctx.event.shiftKey) {
          // Shift+Enter creates new sibling node below current
          ctx.component.createNewNodeAfter(ctx.focusedNodeId);
        } else if (ctx.event.altKey) {
          // Alt+Enter creates new child node
          ctx.component.createChildNode(ctx.focusedNodeId);
        } else {
          // Enter starts editing
          ctx.component.startEditing(ctx.focusedNodeId);
        }
      }
    }
  },

  Backspace: {
    execute(ctx: KeyboardContext): void {
      // Only delete nodes when Cmd/Ctrl is held down
      if (ctx.event.metaKey || ctx.event.ctrlKey) {
        ctx.event.preventDefault();
        if (ctx.focusedNodeId) {
          ctx.component.deleteNode(ctx.focusedNodeId);
        }
      }
    }
  },

  Delete: {
    execute(ctx: KeyboardContext): void {
      // Only delete nodes when Cmd/Ctrl is held down
      if (ctx.event.metaKey || ctx.event.ctrlKey) {
        ctx.event.preventDefault();
        if (ctx.focusedNodeId) {
          ctx.component.deleteNode(ctx.focusedNodeId);
        }
      }
    }
  },

  Tab: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNodeId) {
        if (ctx.event.shiftKey) {
          ctx.component.outdentNode(ctx.focusedNodeId);
        } else {
          ctx.component.indentNode(ctx.focusedNodeId);
        }
      }
    }
  },

  Space: {
    execute(ctx: KeyboardContext): void {
      // Space toggles expand/collapse on parent nodes
      ctx.event.preventDefault();
      if (ctx.focusedNodeId) {
        const node = ctx.component.findNode(ctx.focusedNodeId);
        if (node && node.children.length > 0) {
          node.collapsed = !node.collapsed;
          ctx.component.requestUpdate();
        }
      }
    }
  }
};

/**
 * Pure data transformation functions for editing operations
 */
export const EditingOperations = {
  /**
   * Apply edit completion to a node - pure data transformation
   */
  completeEdit(
    nodes: OutlineNode[], 
    nodeId: string, 
    newContent: string
  ): { updatedNodes: OutlineNode[]; success: boolean } {
    const node = TreeOperations.findNode(nodes, nodeId);
    if (!node) {
      return { updatedNodes: nodes, success: false };
    }

    // Create updated node with new content
    const updatedNode = { ...node, content: newContent };
    
    // For simplicity, we'll mutate in place for now, but this could be made immutable
    node.content = newContent;
    
    return { updatedNodes: nodes, success: true };
  },

  /**
   * Prepare state for editing - pure data transformation
   */
  prepareEditingState(
    currentEditingNodeId: string | null,
    currentEditingContent: string,
    nodeId: string,
    nodeContent: string
  ): {
    editingNodeId: string;
    editingContent: string;
    showingMentions: boolean;
  } {
    return {
      editingNodeId: nodeId,
      editingContent: nodeContent,
      showingMentions: false,
    };
  },

  /**
   * Clear editing state - pure data transformation
   */
  clearEditingState(): {
    editingNodeId: null;
    editingContent: string;
    showingMentions: boolean;
  } {
    return {
      editingNodeId: null,
      editingContent: "",
      showingMentions: false,
    };
  }
};

/**
 * Side effect operations for outliner
 */
export const OutlinerEffects = {
  /**
   * Focus the outliner element for keyboard navigation
   */
  focusOutliner(shadowRoot: ShadowRoot | null): void {
    if (!shadowRoot) return;
    
    setTimeout(() => {
      const outliner = shadowRoot.querySelector('.outliner') as HTMLElement;
      outliner?.focus();
    }, 0);
  },

  /**
   * Focus and select text in an editor
   */
  focusEditor(shadowRoot: ShadowRoot | null, nodeId: string): void {
    if (!shadowRoot) return;
    
    setTimeout(() => {
      const editor = shadowRoot.querySelector(`#editor-${nodeId}`) as HTMLTextAreaElement;
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
    position: number
  ): void {
    if (!shadowRoot) return;
    
    setTimeout(() => {
      const editor = shadowRoot.querySelector(`#editor-${nodeId}`) as HTMLTextAreaElement;
      if (editor) {
        editor.setSelectionRange(position, position);
        editor.focus();
      }
    }, 0);
  }
};

export class CTOutliner extends BaseElement {
  static override properties = {
    value: { type: String },
    readonly: { type: Boolean },
    mentionable: { type: Array },
    nodes: { type: Array, state: true },
    focusedNodeId: { type: String, state: true },
    showingMentions: { type: Boolean, state: true },
    mentionQuery: { type: String, state: true },
    selectedMentionIndex: { type: Number, state: true },
  };

  private _value = "";
  get value() {
    return this._value;
  }
  set value(newValue: string) {
    const oldValue = this._value;
    this._value = newValue;
    
    // Only parse markdown if this is an external change
    if (!this._internalChange && oldValue !== newValue) {
      this.nodes = this.parseMarkdown(newValue);
      if (this.nodes.length === 0) {
        this.nodes = [this.createNode("", 0)];
      }
      // Maintain focus on first node if needed
      if (!this.focusedNodeId && this.nodes.length > 0) {
        this.focusedNodeId = this.nodes[0].id;
      }
    }
    
    this.requestUpdate("value", oldValue);
  }
  
  declare readonly: boolean;
  declare mentionable: MentionableItem[];
  declare nodes: OutlineNode[];
  declare focusedNodeId: string | null;
  declare showingMentions: boolean;
  declare mentionQuery: string;
  declare selectedMentionIndex: number;

  private nodeIdCounter = 0;
  private editingNodeId: string | null = null;
  private editingContent: string = "";
  private _internalChange = false;

  // Test helpers - expose some internal state for testing
  get _testHelpers() {
    return {
      editingNodeId: this.editingNodeId,
      editingContent: this.editingContent,
      createNode: (content: string, level: number) => this.createNode(content, level),
      nodesToMarkdown: (nodes: OutlineNode[]) => this.nodesToMarkdown(nodes),
      emitChange: () => this.emitChange(),
      startEditing: (nodeId: string) => this.startEditing(nodeId),
      handleKeyDown: (event: KeyboardEvent) => this.handleKeyDown(event),
      handleEditorKeyDown: (event: KeyboardEvent) => this.handleEditorKeyDown(event),
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
    this.value = "";
    this.readonly = false;
    this.mentionable = [];
    this.nodes = [];
    this.focusedNodeId = null;
    this.showingMentions = false;
    this.mentionQuery = "";
    this.selectedMentionIndex = 0;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Only initialize nodes if they haven't been set yet
    if (!this.nodes || this.nodes.length === 0) {
      this.nodes = this.parseMarkdown(this.value);
      if (this.nodes.length === 0) {
        this.nodes = [this.createNode("", 0)];
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
    return TreeOperations.createNode(content, level, this.nodeIdCounter++);
  }

  private parseMarkdown(markdown: string): OutlineNode[] {
    if (!markdown.trim()) return [];

    const lines = markdown.split("\n");
    const root: OutlineNode[] = [];
    const stack: { node: OutlineNode; parent: OutlineNode[] }[] = [];

    for (const line of lines) {
      const match = line.match(/^(\s*)-\s(.*)$/);
      if (!match) continue;

      const [, indent, content] = match;
      const level = Math.floor(indent.length / 2);
      const node = this.createNode(content, level);

      while (stack.length > 0 && stack[stack.length - 1].node.level >= level) {
        stack.pop();
      }

      if (stack.length === 0) {
        root.push(node);
      } else {
        stack[stack.length - 1].node.children.push(node);
      }

      stack.push({
        node,
        parent: stack.length === 0
          ? root
          : stack[stack.length - 1].node.children,
      });
    }

    return root;
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

  private findNodeParent(id: string, nodes: OutlineNode[] = this.nodes): OutlineNode[] | null {
    return TreeOperations.findNodeParent(nodes, id) as OutlineNode[] | null;
  }

  findParentNode(id: string, nodes: OutlineNode[] = this.nodes): OutlineNode | null {
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
      node.content
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
      this.editingContent
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
    this.emitChange();
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
        const outliner = this.shadowRoot?.querySelector('.outliner') as HTMLElement;
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
    const currentIndex = allNodes.findIndex(n => n.id === this.editingNodeId);
    
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

    // Store the node ID to maintain focus after indentation
    const nodeId = this.editingNodeId;

    if (outdent) {
      this.outdentNode(this.editingNodeId);
    } else {
      this.indentNode(this.editingNodeId);
    }

    // Restore focus to the editor after indentation
    setTimeout(() => {
      const editor = this.shadowRoot?.querySelector(
        `#editor-${nodeId}`,
      ) as HTMLTextAreaElement;
      if (editor) {
        editor.focus();
      }
    }, 0);
  }

  private handleEditorInput(event: Event) {
    this.editingContent = (event.target as HTMLTextAreaElement).value;
    this.checkForMentions(event.target as HTMLTextAreaElement);
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
      const outliner = this.shadowRoot?.querySelector('.outliner');
      
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
    const target = event.target as HTMLTextAreaElement;

    // Handle mention navigation when dropdown is showing
    if (this.showingMentions) {
      const filteredMentions = this.getFilteredMentions();

      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.selectedMentionIndex = Math.min(
          this.selectedMentionIndex + 1,
          filteredMentions.length - 1,
        );
        this.requestUpdate();
        return;
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.selectedMentionIndex = Math.max(this.selectedMentionIndex - 1, 0);
        this.requestUpdate();
        return;
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (filteredMentions[this.selectedMentionIndex]) {
          this.insertMention(filteredMentions[this.selectedMentionIndex]);
        }
        return;
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.showingMentions = false;
        this.requestUpdate();
        return;
      }
    }

    // Normal editor key handling
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) {
        // Cmd/Ctrl+Enter creates new sibling node (same as Shift+Enter)
        this.finishEditingAndCreateNew();
      } else {
        // Enter confirms edit and returns to read mode
        this.finishEditing();
      }
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // Cancel edit, revert to original text
      this.cancelEditing();
    } else if (event.key === "Tab") {
      event.preventDefault();
      this.handleIndentation(event.shiftKey);
    } else if (event.key === "Backspace") {
      if (this.editingContent === "" || (target.selectionStart === 0 && this.editingContent === "")) {
        event.preventDefault();
        this.deleteCurrentNode();
      }
    } else if (event.key === "Delete") {
      // Check if at end of node and there's a next node to merge with
      if (target.selectionStart === this.editingContent.length) {
        const allNodes = this.getAllNodes();
        const currentNodeIndex = allNodes.findIndex(n => n.id === this.editingNodeId);
        if (currentNodeIndex !== -1 && currentNodeIndex < allNodes.length - 1) {
          event.preventDefault();
          this.mergeWithNextNode();
        }
      }
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

    const command = KeyboardCommands[event.key as keyof typeof KeyboardCommands];
    if (command) {
      command.execute(context);
    }
  }

  private emitChange() {
    const newValue = this.nodesToMarkdown(this.nodes);
    this._internalChange = true;
    this.value = newValue;
    this._internalChange = false;
    this.emit("ct-change", { value: newValue });
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
    const parentArray = this.findNodeParent(nodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(nodeId, parentArray);

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

    // Focus previous node or next node
    const allNodes = this.getAllNodes();
    
    // If no nodes remain, create a new root node
    if (allNodes.length === 0) {
      const newNode = this.createNode("", 0);
      this.nodes = [newNode];
      this.focusedNodeId = newNode.id;
    } else {
      const deletedIndex = allNodes.findIndex((n) => n.id === nodeToDelete.id);
      if (deletedIndex > 0) {
        this.focusedNodeId = allNodes[Math.max(0, deletedIndex - 1)].id;
      } else if (this.nodes.length > 0) {
        this.focusedNodeId = this.getAllNodes()[0].id;
      }
    }

    this.requestUpdate();
    this.emitChange();
  }

  moveNodeUp(nodeId: string | null) {
    if (!nodeId) return;

    const parentArray = this.findNodeParent(nodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(nodeId, parentArray);

    if (currentIndex <= 0) return; // Can't move up if first or not found

    // Swap with previous sibling
    const node = parentArray[currentIndex];
    parentArray.splice(currentIndex, 1);
    parentArray.splice(currentIndex - 1, 0, node);

    this.requestUpdate();
    this.emitChange();
  }

  moveNodeDown(nodeId: string | null) {
    if (!nodeId) return;

    const parentArray = this.findNodeParent(nodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(nodeId, parentArray);

    if (currentIndex === -1 || currentIndex >= parentArray.length - 1) return; // Can't move down if last or not found

    // Swap with next sibling
    const node = parentArray[currentIndex];
    parentArray.splice(currentIndex, 1);
    parentArray.splice(currentIndex + 1, 0, node);

    this.requestUpdate();
    this.emitChange();
  }

  indentNode(nodeId: string) {
    const node = this.findNode(nodeId);
    if (!node) return;

    const parentArray = this.findNodeParent(nodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(nodeId, parentArray);

    if (currentIndex <= 0) return; // Cannot indent if first child or not found

    // Get previous sibling
    const prevSibling = parentArray[currentIndex - 1];

    // Remove from current position
    parentArray.splice(currentIndex, 1);

    // Add as child of previous sibling
    prevSibling.children.push(node);
    node.level = prevSibling.level + 1;

    // Ensure previous sibling is expanded
    prevSibling.collapsed = false;

    // Update levels of all descendants
    this.updateNodeLevels(node);

    this.requestUpdate();
    this.emitChange();
  }

  outdentNode(nodeId: string) {
    const node = this.findNode(nodeId);
    if (!node || node.level === 0) return; // Cannot outdent root level

    const parentNode = this.findParentNode(nodeId);
    if (!parentNode) return;

    const parentArray = parentNode.children;
    const currentIndex = this.getNodeIndex(nodeId, parentArray);
    if (currentIndex === -1) return;

    // Find grandparent array
    const grandParentArray = this.findNodeParent(parentNode.id) || this.nodes;
    const parentIndex = this.getNodeIndex(parentNode.id, grandParentArray);

    // Remove from current position
    parentArray.splice(currentIndex, 1);

    // Move any following siblings as children of this node
    const followingSiblings = parentArray.splice(currentIndex);
    node.children.push(...followingSiblings);

    // Insert after parent
    grandParentArray.splice(parentIndex + 1, 0, node);
    node.level = parentNode.level;

    // Update levels of all descendants
    this.updateNodeLevels(node);

    this.requestUpdate();
    this.emitChange();
  }

  private updateNodeLevels(node: OutlineNode) {
    for (const child of node.children) {
      child.level = node.level + 1;
      this.updateNodeLevels(child);
    }
  }

  override render() {
    return html`
      <div
        class="outliner"
        @keydown="${this.handleKeyDown}"
        @click="${this.handleOutlinerClick}"
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

  private decodeCharmFromHref(href: string | null): CharmReference | string | null {
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
          ${hasChildren
        ? html`
          <div
            class="collapse-icon ${node.collapsed ? "collapsed" : ""}"
            @click="${(e: MouseEvent) => this.handleCollapseClick(node.id, e)}"
          >
            <svg viewBox="0 0 24 24">
              <path d="M7 10l5 5 5-5H7z" />
            </svg>
          </div>
        `
        : html`
          <div style="width: 1.25rem;"></div>
        `}

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
