import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell, isCell } from "@commontools/runner";
// Removed cell-controller import - working directly with Cell
import "../ct-input/ct-input.ts";

type ListItem = {
  title: string;
};

/**
 * Finds the index of an item in a Cell array by comparing Cell equality
 * @param listCell - The Cell containing the array
 * @param itemCell - The Cell to find in the array
 * @returns The index of the item, or -1 if not found
 */
function findCellIndex<T>(listCell: Cell<T[]>, itemCell: Cell<T>): number {
  const length = listCell.get().length;
  for (let i = 0; i < length; i++) {
    if (itemCell.equals(listCell.key(i))) {
      return i;
    }
  }
  return -1;
}

/**
 * Executes a mutation on a Cell within a transaction
 * @param cell - The Cell to mutate
 * @param mutator - Function that performs the mutation
 */
function mutateCell<T>(cell: Cell<T>, mutator: (cell: Cell<T>) => void): void {
  const tx = cell.runtime.edit();
  mutator(cell.withTx(tx));
  tx.commit();
}


/**
 * Action configuration for list items
 */
export interface CtListAction {
  type: "remove" | "accept" | "custom";
  label?: string;
  event?: string;
}


/**
 * CTList - A list component that renders items with add/remove functionality
 * Supports both Cell<T[]> and plain T[] values for reactive data binding
 *
 * @element ct-list
 *
 * @attr {T[]|Cell<T[]>} value - Array of list items (supports both plain array and Cell<T[]>)
 * @attr {string} title - List title
 * @attr {boolean} readonly - Whether the list is read-only
 * @attr {boolean} editable - Whether individual items can be edited in-place
 * @attr {CtListAction} action - Action button config
 *
 * @fires ct-add-item - Fired when adding an item with detail: { message }
 * @fires ct-remove-item - Fired when removing an item with detail: { item }
 * @fires ct-accept-item - Fired when accepting an item with detail: { item }
 * @fires ct-action-item - Fired for custom actions with detail: { item }
 * @fires ct-edit-item - Fired when editing an item with detail: { item, oldItem }
 *
 * @example
 * <ct-list .value="${items}" title="My List" .action="${{type: 'accept'}}" @ct-accept-item="${handleAccept}"></ct-list>
 *
 * @example
 * <!-- With Cell binding -->
 * <ct-list .value="${itemsCell}" title="Reactive List" editable></ct-list>
 */

export class CTList extends BaseElement {
  @property()
  value: Cell<ListItem[]> | null = null;

  @property()
  override title: string = "";

  @property()
  readonly: boolean = false;

  @property()
  editable: boolean = false;

  @property()
  action: CtListAction | null = { type: "remove" };


  // Removed cellController - working directly with value/Cell

  // Private state for managing editing
  @state()
  private _editing: Cell<ListItem> | null = null;

  constructor() {
    super();
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

    /* Editing-specific styles */
    .item-content.editable {
      cursor: pointer;
      user-select: none;
    }

    .item-content.editable:hover {
      background-color: var(--muted);
      border-radius: 0.25rem;
      padding: 0.125rem 0.25rem;
      margin: -0.125rem -0.25rem;
    }

    .list-item.editing {
      background-color: var(--muted);
    }

    .list-item.editing .item-content {
      flex: 1;
      margin: -0.25rem 0;
    }

    .edit-input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 0.25rem;
      padding: 0.25rem;
      font-size: inherit;
      font-family: inherit;
      background: var(--background);
      color: var(--text);
    }

    .edit-input:focus {
      outline: 2px solid var(--primary);
      outline-offset: -1px;
    }

    .item-action.edit {
      background-color: #3b82f6;
      color: white;
      font-size: 0.6rem;
    }

    .item-action.edit:hover {
      background-color: #2563eb;
    }

    .item-action.cancel {
      background-color: #6b7280;
      color: white;
    }

    .item-action.cancel:hover {
      background-color: #4b5563;
    }

  `;

  // Lifecycle methods for Cell binding management
  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);
  }

  private addItem(title: string): void {
    if (!this.value) {
      console.warn("Cannot add item to an empty list");
      return;
    }

    const newItem = { title } as ListItem;
    mutateCell(this.value, (cell) => cell.push(newItem));
    this.requestUpdate();
  }

  private removeItem(itemToRemove: Cell<any>): void {
    if (!this.value) {
      console.warn("Cannot remove item from an empty list");
      return;
    }

    const index = findCellIndex(this.value, itemToRemove);
    if (index !== -1) {
      mutateCell(this.value, (cell) => cell.get().splice(index, 1));
    }

    this.requestUpdate();
  }

  private handleActionItem(item: Cell<ListItem>) {
    if (!this.action) return;

    switch (this.action.type) {
      case "remove":
        this.removeItem(item);
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
      this.addItem(message.trim());
      this.emit("ct-add-item", { message: message.trim() });
      form.reset();
    }
  }

  private startEditing(item: Cell<ListItem>): void {
    if (!this.editable) return;
    if (!isCell(this.value)) return;

    const index = findCellIndex(this.value, item);
    if (index !== -1) {
      this._editing = item;
      this.requestUpdate();
    }
  }

  private finishEditing(item: Cell<ListItem>, newTitle: string): void {
    if (!this.editable) return;
    if (!this.value) return;

    const trimmedTitle = newTitle.trim();
    if (trimmedTitle) {
      const index = findCellIndex(this.value, item);
      if (index !== -1) {
        mutateCell(this.value, (cell) => {
          cell.key(index).key("title").set(trimmedTitle);
        });

        this.emit("ct-edit-item", {
          item: { ...item, title: trimmedTitle },
          oldItem: item,
        });

        this._editing = null;
        this.requestUpdate();
      }
    }
  }

  private cancelEditing(): void {
    this._editing = null;
    this.requestUpdate();
  }

  override render() {
    if (!this.value) {
      return html`
        <div class="empty-state">No items in this list</div>
      `;
    }
    const cell = this.value;
    const items = this.value.get();

    return html`
      <div class="list-container">
        ${this.title
        ? html`
          <h2 class="list-title">${this.title}</h2>
        `
        : ""}

        <div class="list-items">
          ${items.filter((item) => item && item.title).length === 0
        ? html`
          <div class="empty-state">No items in this list</div>
        `
        : repeat(
          items.filter((item) => item && item.title),
          (item, index) => `${index}-${item.title}`,
          (item, index) => this.renderItem(cell.key(index), index),
        )}
        </div>

        ${!this.readonly ? this.renderAddItem() : ""}
      </div>

    `;
  }

  private renderItem(item: Cell<ListItem>, index: number) {
    const isEditing = this._editing?.equals(item);

    const actionButton = this.action && !this.readonly
      ? this.renderActionButton(item)
      : "";

    // If item is being edited, show input
    if (isEditing) {
      return html`
        <div class="list-item editing">
          <div class="item-bullet"></div>
          <div class="item-content">
            <input
              type="text"
              class="edit-input"
              .value="${item.get().title}"
              @input="${(e: Event) => {
          this._editing = item;
        }}"
              @blur="${(e: Event) => {
          const target = e.target as HTMLInputElement;
          this.finishEditing(item, target.value);
        }}"
              @keydown="${(e: KeyboardEvent) => {
          if (e.key === "Enter") {
            const target = e.target as HTMLInputElement;
            this.finishEditing(item, target.value);
          } else if (e.key === "Escape") {
            this.cancelEditing();
          }
        }}"
              autofocus
            />
          </div>
          <button
            class="item-action cancel"
            @click="${() => this.cancelEditing()}"
            title="Cancel editing"
          >
            ×
          </button>
        </div>
      `;
    }

    return html`
      <div
        class="list-item"
      >
        <div class="item-bullet"></div>
        <div
          class="item-content ${this.editable && !this.readonly
        ? "editable"
        : ""}"
          @dblclick="${() => this.startEditing(item)}"
        >
          ${item.get().title}
        </div>
        ${this.editable && !this.readonly
        ? html`
          <button
            class="item-action edit"
            @click="${() => this.startEditing(item)}"
            title="Edit item"
          >
            ✎
          </button>
        `
        : ""} ${actionButton}
      </div>
    `;
  }

  private renderActionButton(item: Cell<ListItem>) {
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
