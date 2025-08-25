import { css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTTags - A tags component that renders tags as pills with add/remove functionality
 *
 * @element ct-tags
 *
 * @attr {Array<string>} tags - Array of tag strings
 * @attr {boolean} readonly - Whether the tags are read-only
 *
 * @fires ct-change - Fired when tags change with detail: { tags }
 *
 * @example
 * <ct-tags .tags="${['tag1', 'tag2']}" @ct-change="${handleTagsChange}"></ct-tags>
 */

export class CTTags extends BaseElement {
  static override properties = {
    tags: { type: Array },
    readonly: { type: Boolean },
    editingIndex: { type: Number, state: true },
    originalTagValue: { type: String, state: true },
    newTagValue: { type: String, state: true },
    showingNewInput: { type: Boolean, state: true },
  };

  declare tags: string[];
  declare readonly: boolean;
  declare editingIndex: number | null;
  declare originalTagValue: string;
  declare newTagValue: string;
  declare showingNewInput: boolean;

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
      --accent: #3b82f6;
      --accent-foreground: #ffffff;
      --destructive: #ef4444;
      --destructive-foreground: #ffffff;

      --tags-gap: 0.5rem;
      --tag-padding: 0.25rem 0.75rem;
      --tag-border-radius: 9999px;
      --tag-font-size: 0.875rem;
    }

    .tags-container {
      display: flex;
      flex-wrap: wrap;
      gap: var(--tags-gap);
      align-items: center;
      min-height: 2rem;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: var(--tag-padding);
      background-color: var(--muted);
      border: 1px solid var(--border);
      border-radius: var(--tag-border-radius);
      font-size: var(--tag-font-size);
      color: var(--foreground);
      transition: all 0.2s;
      user-select: none;
    }

    .tag:hover {
      background-color: var(--accent);
      color: var(--accent-foreground);
      border-color: var(--accent);
    }

    .tag.editing {
      background-color: var(--background);
      border-color: var(--ring);
      outline: 2px solid var(--ring);
      outline-offset: -2px;
    }

    .tag-text {
      flex: 1;
      min-width: 0;
    }

    .tag-input {
      background: transparent;
      border: none;
      outline: none;
      font: inherit;
      color: inherit;
      min-width: 3rem;
      width: 100%;
    }

    .tag-remove {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1rem;
      height: 1rem;
      border-radius: 50%;
      background-color: var(--destructive);
      color: var(--destructive-foreground);
      cursor: pointer;
      font-size: 0.75rem;
      line-height: 1;
      transition: opacity 0.2s;
      opacity: 0;
    }

    .tag:hover .tag-remove {
      opacity: 1;
    }

    .tag-remove:hover {
      background-color: #dc2626;
    }

    .add-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: var(--tag-padding);
      background-color: transparent;
      border: 1px dashed var(--border);
      border-radius: var(--tag-border-radius);
      font-size: var(--tag-font-size);
      color: var(--muted-foreground);
      cursor: pointer;
      transition: all 0.2s;
      min-width: 4rem;
    }

    .add-tag:hover {
      border-color: var(--accent);
      color: var(--accent);
      background-color: var(--muted);
    }

    .add-tag.active {
      border-color: var(--ring);
      background-color: var(--background);
      outline: 2px solid var(--ring);
      outline-offset: -2px;
    }

    .add-tag-input {
      background: transparent;
      border: none;
      outline: none;
      font: inherit;
      color: var(--foreground);
      min-width: 3rem;
      flex: 1;
    }

    .add-tag-input::placeholder {
      color: var(--muted-foreground);
    }

    .placeholder {
      color: var(--muted-foreground);
      font-style: italic;
      padding: var(--tag-padding);
    }
  `;

  constructor() {
    super();
    this.tags = [];
    this.readonly = false;
    this.editingIndex = null;
    this.originalTagValue = "";
    this.newTagValue = "";
    this.showingNewInput = false;
  }

  private handleTagClick(index: number, event: MouseEvent) {
    if (this.readonly) return;

    event.preventDefault();
    this.editingIndex = index;
    this.originalTagValue = this.tags[index]; // Store original value
    this.requestUpdate();

    // Focus the input after render
    setTimeout(() => {
      const input = this.shadowRoot?.querySelector(
        `#tag-input-${index}`,
      ) as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  private handleTagRemove(index: number, event: MouseEvent) {
    if (this.readonly) return;

    event.stopPropagation();
    const newTags = [...this.tags];
    newTags.splice(index, 1);
    this.tags = newTags;
    this.emit("ct-change", { tags: this.tags });
  }

  private handleTagInput(index: number, event: Event) {
    // Update the tag value as user types
    const input = event.target as HTMLInputElement;
    const newTags = [...this.tags];
    newTags[index] = input.value;
    this.tags = newTags;
  }

  private handleTagKeyDown(index: number, event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.finishEditingTag(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      // Restore original value
      const newTags = [...this.tags];
      newTags[index] = this.originalTagValue;
      this.tags = newTags;
      this.editingIndex = null;
      this.requestUpdate();
    } else if (event.key === "Backspace") {
      // Check if the input is empty
      const input = event.target as HTMLInputElement;
      if (input.value === "") {
        event.preventDefault();
        this.handleTagRemove(index, new MouseEvent("click"));
      }
    }
  }

  private handleTagBlur(index: number) {
    this.finishEditingTag(index);
  }

  private finishEditingTag(index: number) {
    const tag = this.tags[index]?.trim();
    if (!tag) {
      // Remove empty tag
      this.handleTagRemove(index, new MouseEvent("click"));
    } else {
      // Update tag and emit change
      const newTags = [...this.tags];
      newTags[index] = tag;
      this.tags = newTags;
      this.emit("ct-change", { tags: this.tags });
    }

    this.editingIndex = null;
    this.requestUpdate();
  }

  private handleAddTagClick() {
    if (this.readonly) return;

    this.showingNewInput = true;
    this.newTagValue = "";
    this.requestUpdate();

    setTimeout(() => {
      const input = this.shadowRoot?.querySelector(
        "#new-tag-input",
      ) as HTMLInputElement;
      if (input) {
        input.focus();
      }
    }, 0);
  }

  private handleNewTagInput(event: Event) {
    this.newTagValue = (event.target as HTMLInputElement).value;
  }

  private handleNewTagKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.addNewTag();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.cancelNewTag();
    }
  }

  private handleNewTagBlur() {
    if (this.newTagValue.trim()) {
      this.addNewTag();
    } else {
      this.cancelNewTag();
    }
  }

  private addNewTag() {
    const tag = this.newTagValue.trim();
    if (tag && !this.tags.includes(tag)) {
      this.tags = [...this.tags, tag];
      this.emit("ct-change", { tags: this.tags });
    }
    this.cancelNewTag();
  }

  private cancelNewTag() {
    this.showingNewInput = false;
    this.newTagValue = "";
    this.requestUpdate();
  }

  override render() {
    return html`
      <div class="tags-container">
        ${this.tags.length === 0 && !this.showingNewInput
        ? html`
          <span class="placeholder">No tags</span>
        `
        : ""} ${repeat(
          this.tags,
          (tag, index) => index,
          (tag, index) => this.renderTag(tag, index),
        )} ${!this.readonly ? this.renderAddTag() : ""}
      </div>
    `;
  }

  private renderTag(tag: string, index: number) {
    const isEditing = this.editingIndex === index;

    return html`
      <div
        class="tag ${isEditing ? "editing" : ""}"
        @click="${(e: MouseEvent) => this.handleTagClick(index, e)}"
      >
        ${isEditing
        ? html`
          <input
            id="tag-input-${index}"
            class="tag-input"
            .value="${tag}"
            @input="${(e: Event) => this.handleTagInput(index, e)}"
            @keydown="${(e: KeyboardEvent) => this.handleTagKeyDown(index, e)}"
            @blur="${() => this.handleTagBlur(index)}"
          />
        `
        : html`
          <span class="tag-text">${tag}</span>
          ${!this.readonly
            ? html`
              <div
                class="tag-remove"
                @click="${(e: MouseEvent) => this.handleTagRemove(index, e)}"
                title="Remove tag"
              >
                ×
              </div>
            `
            : ""}
        `}
      </div>
    `;
  }

  private renderAddTag() {
    return html`
      <div
        class="add-tag ${this.showingNewInput ? "active" : ""}"
        @click="${this.handleAddTagClick}"
      >
        ${this.showingNewInput
        ? html`
          <input
            id="new-tag-input"
            class="add-tag-input"
            placeholder="New tag"
            .value="${this.newTagValue}"
            @input="${this.handleNewTagInput}"
            @keydown="${this.handleNewTagKeyDown}"
            @blur="${this.handleNewTagBlur}"
          />
        `
        : html`
          + Add tag
        `}
      </div>
    `;
  }
}

globalThis.customElements.define("ct-tags", CTTags);
