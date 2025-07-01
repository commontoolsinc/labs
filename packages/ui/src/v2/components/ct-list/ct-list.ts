import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTList - A list component that renders items with add/remove functionality
 *
 * @element ct-list
 *
 * @attr {Object} list - List object with title and items array
 * @attr {boolean} readonly - Whether the list is read-only
 * @attr {Object} action - Action button config: { type: 'remove'|'accept'|'custom', label?: string, event?: string }
 *
 * @fires ct-add-item - Fired when adding an item with detail: { message }
 * @fires ct-remove-item - Fired when removing an item with detail: { item }
 * @fires ct-accept-item - Fired when accepting an item with detail: { item }
 * @fires ct-action-item - Fired for custom actions with detail: { item }
 *
 * @example
 * <ct-list .list="${{title: 'My List', items: [...]}}" .action="${{type: 'accept'}}" @ct-accept-item="${handleAccept}"></ct-list>
 */

export class CTList extends BaseElement {
  @property({ type: Object })
  accessor list: {
    title: string;
    items: Array<{ title: string; done?: boolean }>;
  } = { title: "", items: [] };

  @property({ type: Boolean })
  accessor readonly: boolean = false;

  @property({ type: Object })
  accessor action: {
    type: "remove" | "accept" | "custom";
    label?: string;
    event?: string;
  } | null = { type: "remove" };

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
      --destructive: #ef4444;
      --destructive-foreground: #ffffff;

      --list-padding: 1rem;
      --list-border-radius: 0.5rem;
      --list-border: 1px solid var(--border);
      --item-gap: 0.5rem;
    }

    .list-container {
      background-color: var(--background);
      border: var(--list-border);
      border-radius: var(--list-border-radius);
      padding: var(--list-padding);
    }

    .list-title {
      font-weight: bold;
      font-size: 1.125rem;
      margin-bottom: 1rem;
      color: var(--foreground);
    }

    .list-items {
      display: flex;
      flex-direction: column;
      gap: var(--item-gap);
      margin-bottom: 1rem;
    }

    .list-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem;
      border-radius: 0.25rem;
      transition: background-color 0.1s;
    }

    .list-item:hover {
      background-color: var(--muted);
    }

    .item-bullet {
      width: 0.375rem;
      height: 0.375rem;
      background-color: var(--foreground);
      border-radius: 50%;
      flex-shrink: 0;
      margin-left: 1rem;
    }

    .item-content {
      flex: 1;
      color: var(--foreground);
    }

    .item-action {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.5rem;
      height: 1.5rem;
      border-radius: 0.25rem;
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: bold;
      transition: opacity 0.2s;
      opacity: 0;
      border: none;
    }

    .list-item:hover .item-action {
      opacity: 1;
    }

    .item-action.remove {
      background-color: var(--destructive);
      color: var(--destructive-foreground);
    }

    .item-action.remove:hover {
      background-color: #dc2626;
    }

    .item-action.accept {
      background-color: #22c55e;
      color: #ffffff;
    }

    .item-action.accept:hover {
      background-color: #16a34a;
    }

    .add-item-container {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    .add-item-input {
      flex: 1;
      padding: 0.5rem;
      border: 1px solid var(--border);
      border-radius: 0.25rem;
      font-size: 0.875rem;
      color: var(--foreground);
      background-color: var(--background);
    }

    .add-item-input:focus {
      outline: 2px solid var(--ring);
      outline-offset: -2px;
      border-color: var(--ring);
    }

    .add-item-input::placeholder {
      color: var(--muted-foreground);
    }

    .add-item-button {
      padding: 0.5rem 1rem;
      background-color: var(--ring);
      color: var(--background);
      border: none;
      border-radius: 0.25rem;
      font-size: 0.875rem;
      cursor: pointer;
      transition: background-color 0.1s;
    }

    .add-item-button:hover {
      background-color: #64748b;
    }

    .add-item-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .empty-state {
      color: var(--muted-foreground);
      font-style: italic;
      text-align: center;
      padding: 1rem;
    }
  `;

  private handleActionItem(item: { title: string; done?: boolean }) {
    if (!this.action) return;

    switch (this.action.type) {
      case "remove":
        this.emit("ct-remove-item", { item });
        break;
      case "accept":
        this.emit("ct-accept-item", { item });
        break;
      case "custom":
        this.emit(this.action.event || "ct-action-item", { item });
        break;
    }
  }

  private handleAddItem(event: Event) {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const formData = new FormData(form);
    const message = formData.get("message") as string;

    if (message?.trim()) {
      this.emit("ct-add-item", { message: message.trim() });
      form.reset();
    }
  }

  override render() {
    if (!this.list) {
      return html`
        <div class="empty-state">No list data</div>
      `;
    }

    return html`
      <div class="list-container">
        <h2 class="list-title">${this.list.title}</h2>

        <div class="list-items">
          ${this.list.items.length === 0
        ? html`
          <div class="empty-state">No items in this list</div>
        `
        : repeat(
          this.list.items,
          (item) => item.title,
          (item) => this.renderItem(item),
        )}
        </div>

        ${!this.readonly ? this.renderAddItem() : ""}
      </div>
    `;
  }

  private renderItem(item: { title: string; done?: boolean }) {
    const actionButton = this.action && !this.readonly
      ? this.renderActionButton(item)
      : "";

    return html`
      <div class="list-item">
        <div class="item-bullet"></div>
        <div class="item-content">${item.title}</div>
        ${actionButton}
      </div>
    `;
  }

  private renderActionButton(item: { title: string; done?: boolean }) {
    if (!this.action) return "";

    const getButtonContent = () => {
      switch (this.action!.type) {
        case "remove":
          return "×";
        case "accept":
          return "+";
        case "custom":
          return this.action!.label || "•";
      }
    };

    const getTitle = () => {
      switch (this.action!.type) {
        case "remove":
          return "Remove item";
        case "accept":
          return "Accept item";
        case "custom":
          return this.action!.label || "Action";
      }
    };

    return html`
      <button
        class="item-action ${this.action.type}"
        @click="${() => this.handleActionItem(item)}"
        title="${getTitle()}"
      >
        ${getButtonContent()}
      </button>
    `;
  }

  private renderAddItem() {
    return html`
      <form class="add-item-container" @submit="${this.handleAddItem}">
        <input
          class="add-item-input"
          name="message"
          placeholder="New item"
          required
        />
        <button class="add-item-button" type="submit">
          Add item
        </button>
      </form>
    `;
  }
}

globalThis.customElements.define("ct-list", CTList);
