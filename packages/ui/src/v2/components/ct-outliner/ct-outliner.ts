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

interface OutlineNode {
  id: string;
  content: string;
  children: OutlineNode[];
  collapsed: boolean;
  level: number;
}

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

  declare value: string;
  declare readonly: boolean;
  declare mentionable: Array<{ name: string; charm: any }>;
  declare nodes: OutlineNode[];
  declare focusedNodeId: string | null;
  declare showingMentions: boolean;
  declare mentionQuery: string;
  declare selectedMentionIndex: number;

  private nodeIdCounter = 0;
  private editingNodeId: string | null = null;
  private editingContent: string = "";

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
    this.nodes = this.parseMarkdown(this.value);
    if (this.nodes.length === 0) {
      this.nodes = [this.createNode("", 0)];
    }
    // Set initial focus to first node if we have nodes
    if (this.nodes.length > 0 && !this.focusedNodeId) {
      this.focusedNodeId = this.nodes[0].id;
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("value") && !this.editingNodeId) {
      const previousNodes = this.nodes;
      this.nodes = this.parseMarkdown(this.value);

      if (this.nodes.length === 0) {
        this.nodes = [this.createNode("", 0)];
      }

      // Preserve focus if possible, otherwise focus first node
      if (this.focusedNodeId) {
        const focusedNode = this.findNode(this.focusedNodeId);
        if (!focusedNode && this.nodes.length > 0) {
          this.focusedNodeId = this.nodes[0].id;
        }
      } else if (this.nodes.length > 0) {
        this.focusedNodeId = this.nodes[0].id;
      }
    }
  }

  private createNode(content: string, level: number): OutlineNode {
    return {
      id: `node-${this.nodeIdCounter++}`,
      content,
      children: [],
      collapsed: false,
      level,
    };
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

  private findNode(
    id: string,
    nodes: OutlineNode[] = this.nodes,
  ): OutlineNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = this.findNode(id, node.children);
      if (found) return found;
    }
    return null;
  }

  private findNodeParent(
    id: string,
    nodes: OutlineNode[] = this.nodes,
    parent: OutlineNode[] | null = null,
  ): OutlineNode[] | null {
    for (const node of nodes) {
      if (node.id === id) return parent;
      const found = this.findNodeParent(id, node.children, node.children);
      if (found) return found;
    }
    return null;
  }

  private getNodeIndex(id: string, nodes: OutlineNode[]): number {
    return nodes.findIndex((node) => node.id === id);
  }

  private getAllNodes(nodes: OutlineNode[] = this.nodes): OutlineNode[] {
    const result: OutlineNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (!node.collapsed) {
        result.push(...this.getAllNodes(node.children));
      }
    }
    return result;
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

  private startEditing(nodeId: string) {
    const node = this.findNode(nodeId);
    if (node) {
      this.editingNodeId = nodeId;
      this.editingContent = node.content;
      this.requestUpdate();

      setTimeout(() => {
        const editor = this.shadowRoot?.querySelector(
          `#editor-${nodeId}`,
        ) as HTMLTextAreaElement;
        if (editor) {
          editor.focus();
          editor.select();
        }
      }, 0);
    }
  }

  private finishEditing() {
    if (this.editingNodeId) {
      const node = this.findNode(this.editingNodeId);
      if (node) {
        node.content = this.editingContent;
        this.editingNodeId = null;
        this.editingContent = "";
        this.showingMentions = false;

        const newValue = this.nodesToMarkdown(this.nodes);
        this.value = newValue;

        this.emit("ct-change", { value: newValue });
      }
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
    const deletedIndex = allNodes.findIndex((n) => n.id === nodeToDelete.id);
    if (deletedIndex > 0) {
      this.focusedNodeId = allNodes[deletedIndex - 1].id;
    } else if (allNodes.length > 1) {
      this.focusedNodeId = allNodes[1].id;
    }

    this.requestUpdate();
    this.emitChange();
  }

  private handleIndentation(outdent: boolean) {
    if (!this.editingNodeId) return;

    const node = this.findNode(this.editingNodeId);
    const parentArray = this.findNodeParent(this.editingNodeId) || this.nodes;
    const currentIndex = this.getNodeIndex(this.editingNodeId, parentArray);

    if (!node || currentIndex === -1) return;

    // Store the node ID to maintain focus after indentation
    const nodeId = this.editingNodeId;

    if (outdent) {
      // Outdent (move left)
      if (node.level > 0) {
        // Find the grandparent array
        let grandParentArray = this.nodes;
        let parentNode = null;

        // Find the actual parent node
        const findParentNode = (nodes: OutlineNode[]): OutlineNode | null => {
          for (const n of nodes) {
            if (n.children.includes(node)) return n;
            const found = findParentNode(n.children);
            if (found) return found;
          }
          return null;
        };

        parentNode = findParentNode(this.nodes);
        if (parentNode) {
          grandParentArray = this.findNodeParent(parentNode.id) || this.nodes;
          const parentIndex = this.getNodeIndex(
            parentNode.id,
            grandParentArray,
          );

          // Remove from current position
          parentArray.splice(currentIndex, 1);

          // Insert after parent
          grandParentArray.splice(parentIndex + 1, 0, node);
          node.level = parentNode.level;

          // Move any following siblings as children of this node
          const followingSiblings = parentArray.splice(currentIndex);
          node.children.push(...followingSiblings);
          followingSiblings.forEach((child) => child.level = node.level + 1);
        }
      }
    } else {
      // Indent (move right)
      if (currentIndex > 0) {
        const prevSibling = parentArray[currentIndex - 1];

        // Remove from current position
        parentArray.splice(currentIndex, 1);

        // Add as child of previous sibling
        prevSibling.children.push(node);
        node.level = prevSibling.level + 1;

        // Ensure previous sibling is expanded
        prevSibling.collapsed = false;
      }
    }

    this.requestUpdate();
    this.emitChange();

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

  private handleEditorBlur = () => {
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
      this.finishEditing();
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

  private safeCharmStringify(charm: any): string {
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.finishEditingAndCreateNew();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.editingNodeId = null;
      this.editingContent = "";
      this.showingMentions = false;
      this.requestUpdate();
    } else if (event.key === "Tab") {
      event.preventDefault();
      this.handleIndentation(event.shiftKey);
    } else if (event.key === "Backspace" && this.editingContent === "") {
      event.preventDefault();
      this.deleteCurrentNode();
    }
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (this.readonly || this.editingNodeId) return;

    const allNodes = this.getAllNodes();
    const currentIndex = allNodes.findIndex((node) =>
      node.id === this.focusedNodeId
    );

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        if (currentIndex > 0) {
          this.focusedNodeId = allNodes[currentIndex - 1].id;
        } else if (currentIndex === -1 && allNodes.length > 0) {
          // If nothing is focused, start from the last node
          this.focusedNodeId = allNodes[allNodes.length - 1].id;
        }
        break;

      case "ArrowDown":
        event.preventDefault();
        if (currentIndex < allNodes.length - 1) {
          this.focusedNodeId = allNodes[currentIndex + 1].id;
        } else if (currentIndex === -1 && allNodes.length > 0) {
          // If nothing is focused, start from the first node
          this.focusedNodeId = allNodes[0].id;
        }
        break;

      case "ArrowLeft":
        event.preventDefault();
        if (this.focusedNodeId) {
          const node = this.findNode(this.focusedNodeId);
          if (node && node.children.length > 0 && !node.collapsed) {
            node.collapsed = true;
            this.requestUpdate();
          }
        }
        break;

      case "ArrowRight":
        event.preventDefault();
        if (this.focusedNodeId) {
          const node = this.findNode(this.focusedNodeId);
          if (node && node.children.length > 0 && node.collapsed) {
            node.collapsed = false;
            this.requestUpdate();
          }
        }
        break;

      case "Enter":
        event.preventDefault();
        if (this.focusedNodeId) {
          if (event.shiftKey) {
            // Shift+Enter creates new node after current
            this.createNewNodeAfter(this.focusedNodeId);
          } else {
            // Enter starts editing
            this.startEditing(this.focusedNodeId);
          }
        }
        break;

      case "Backspace":
      case "Delete":
        event.preventDefault();
        if (this.focusedNodeId) {
          this.deleteNode(this.focusedNodeId);
        }
        break;

      case "Tab":
        event.preventDefault();
        if (this.focusedNodeId) {
          const node = this.findNode(this.focusedNodeId);
          const parent = this.findNodeParent(this.focusedNodeId) || this.nodes;
          const index = this.getNodeIndex(this.focusedNodeId, parent);

          if (node && index >= 0) {
            if (event.shiftKey) {
              if (node.level > 0) {
                node.level--;
                this.requestUpdate();
                this.emitChange();
              }
            } else {
              if (index > 0) {
                const prevSibling = parent[index - 1];
                parent.splice(index, 1);
                prevSibling.children.push(node);
                node.level = prevSibling.level + 1;
                prevSibling.collapsed = false;
                this.requestUpdate();
                this.emitChange();
              }
            }
          }
        }
        break;
    }
  }

  private emitChange() {
    const newValue = this.nodesToMarkdown(this.nodes);
    this.value = newValue;
    this.emit("ct-change", { value: newValue });
  }

  private createNewNodeAfter(nodeId: string) {
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

  private deleteNode(nodeId: string) {
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
    const deletedIndex = allNodes.findIndex((n) => n.id === nodeToDelete.id);
    if (deletedIndex > 0) {
      this.focusedNodeId = allNodes[Math.max(0, deletedIndex - 1)].id;
    } else if (this.nodes.length > 0) {
      this.focusedNodeId = this.getAllNodes()[0].id;
    }

    this.requestUpdate();
    this.emitChange();
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

  private decodeCharmFromHref(href: string | null): any {
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
