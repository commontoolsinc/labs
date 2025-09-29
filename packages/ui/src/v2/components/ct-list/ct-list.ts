import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell, ID, isCell } from "@commontools/runner";
// Removed cell-controller import - working directly with Cell
import "../ct-input/ct-input.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";

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

  // Subscription cleanup function
  private _unsubscribe: (() => void) | null = null;

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  constructor() {
    super();
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
        box-sizing: border-box;
      }

      .list-container {
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-colors-gray-50, #fafafa)
        );
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-colors-gray-300, #e0e0e0));
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-lg, 0.5rem)
        );
        padding: var(--ct-theme-spacing-block, 1rem);
      }

      .list-title {
        font-weight: 600;
        font-size: 1.125rem;
        margin-bottom: 1rem;
        color: var(--ct-theme-color-text, #0f172a);
      }

      .list-items {
        display: flex;
        flex-direction: column;
        gap: var(--ct-theme-spacing-normal, 0.5rem);
        margin-bottom: var(--ct-theme-spacing-normal, 0.5rem);
      }

      .list-item {
        display: flex;
        align-items: center;
        gap: var(--ct-theme-spacing-normal, 0.5rem);
        padding: 0.25rem;
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        transition: background-color var(--ct-theme-animation-duration, 200ms) ease;
      }

      .list-item:hover {
        background-color: var(
          --ct-theme-color-surface-hover,
          var(--ct-colors-gray-100, #f5f5f5)
        );
      }

      .item-bullet {
        width: 0.375rem;
        height: 0.375rem;
        background-color: var(--ct-theme-color-text, #0f172a);
        border-radius: 50%;
        flex-shrink: 0;
        margin-left: 1rem;
      }

      .item-content {
        flex: 1;
        color: var(--ct-theme-color-text, #0f172a);
      }

      .item-action {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.5rem;
        height: 1.5rem;
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-sm, 0.25rem)
        );
        cursor: pointer;
        font-size: 0.75rem;
        font-weight: 600;
        transition: opacity var(--ct-theme-animation-duration, 200ms) ease;
        opacity: 0;
        border: none;
      }

      .list-item:hover .item-action {
        opacity: 1;
      }

      .item-action.remove {
        background-color: var(
          --ct-theme-color-error,
          var(--ct-colors-error, #f44336)
        );
        color: var(
          --ct-theme-color-error-foreground,
          var(--ct-colors-white, #ffffff)
        );
      }

      .item-action.accept {
        background-color: var(
          --ct-theme-color-success,
          var(--ct-colors-success, #22c55e)
        );
        color: var(--ct-theme-color-success-foreground, #ffffff);
      }

      .add-item-container {
        display: flex;
        gap: var(--ct-theme-spacing-normal, 0.5rem);
        align-items: center;
      }

      .add-item-input {
        flex: 1;
        padding: 0.5rem;
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-colors-gray-300, #e0e0e0));
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-sm, 0.25rem)
        );
        font-size: 0.875rem;
        color: var(--ct-theme-color-text, #0f172a);
        background-color: var(
          --ct-theme-color-background,
          var(--ct-colors-white, #ffffff)
        );
      }

      .add-item-input:focus {
        outline: 2px solid
          var(--ct-theme-color-primary, var(--ct-colors-primary-500, #2196f3));
        outline-offset: -2px;
        border-color: var(
          --ct-theme-color-primary,
          var(--ct-colors-primary-500, #2196f3)
        );
      }

      .add-item-input::placeholder {
        color: var(--ct-theme-color-text-muted, #64748b);
      }

      .add-item-button {
        padding: 0.5rem 1rem;
        background-color: var(
          --ct-theme-color-primary,
          var(--ct-colors-primary-500, #2196f3)
        );
        color: var(--ct-theme-color-primary-foreground, #ffffff);
        border: none;
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-sm, 0.25rem)
        );
        font-size: 0.875rem;
        cursor: pointer;
        transition: opacity var(--ct-theme-animation-duration, 200ms) ease;
      }

      .add-item-button:hover {
        opacity: 0.9;
      }

      .add-item-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .empty-state {
        color: var(--ct-theme-color-text-muted, #64748b);
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
        background-color: var(
          --ct-theme-color-surface-hover,
          var(--ct-colors-gray-100, #f5f5f5)
        );
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-sm, 0.25rem)
        );
        padding: 0.125rem 0.25rem;
        margin: -0.125rem -0.25rem;
      }

      .list-item.editing {
        background-color: var(
          --ct-theme-color-surface-hover,
          var(--ct-colors-gray-100, #f5f5f5)
        );
      }

      .list-item.editing .item-content {
        flex: 1;
        margin: -0.25rem 0;
      }

      .edit-input {
        width: 100%;
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-colors-gray-300, #e0e0e0));
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-sm, 0.25rem)
        );
        padding: 0.25rem;
        font-size: inherit;
        font-family: inherit;
        background: var(--ct-theme-color-background, #ffffff);
        color: var(--ct-theme-color-text, #0f172a);
      }

      .edit-input:focus {
        outline: 2px solid
          var(--ct-theme-color-primary, var(--ct-colors-primary-500, #2196f3));
        outline-offset: -1px;
      }

      .item-action.edit {
        background-color: var(
          --ct-theme-color-accent,
          var(--ct-colors-primary-600, #1e88e5)
        );
        color: var(--ct-theme-color-accent-foreground, #ffffff);
        font-size: 0.6rem;
      }

      .item-action.cancel {
        background-color: var(
          --ct-theme-color-secondary,
          var(--ct-colors-gray-200, #eeeeee)
        );
        color: var(--ct-theme-color-text, #0f172a);
      }
    `,
  ];

  // Lifecycle methods for Cell binding management
  override updated(changedProperties: Map<string, any>) {
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
          this.requestUpdate();
        });
      }
    }
  }

  override firstUpdated(changed: Map<string | number | symbol, unknown>) {
    super.firstUpdated(changed as any);
    this.#applyTheme();
  }

  override willUpdate(changed: Map<string | number | symbol, unknown>) {
    if (changed.has("theme")) this.#applyTheme();
  }

  #applyTheme() {
    applyThemeToElement(this, this.theme ?? defaultTheme);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up subscription
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  private addItem(title: string): void {
    if (!this.value) {
      console.warn("Cannot add item to an empty list");
      return;
    }

    const newItem = { title, [ID]: crypto.randomUUID() } as ListItem;
    mutateCell(this.value, (cell) => cell.push(newItem));
    this.requestUpdate();
  }

  private removeItem(itemToRemove: Cell<any>): void {
    if (!this.value) {
      console.warn("Cannot remove item from an empty list");
      return;
    }

    // Use filter with .equals() to remove the item
    mutateCell(this.value, (cell) => {
      const filtered = cell.get().filter((_, i) =>
        !cell.key(i).equals(itemToRemove)
      );
      cell.set(filtered);
    });

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
      <div class="list-item">
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
