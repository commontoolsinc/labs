import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell, getEntityId, isCell } from "@commontools/runner";
import { type Charm, charmId, charmSchema } from "@commontools/charm";
import {
  type ArrayCellController,
  createArrayCellController,
} from "../../core/cell-controller.ts";
import "../ct-render/ct-render.ts";

/**
 * Interface for kanban items - each item is a Cell that must expose
 * at least a status property for column placement
 */
export interface KanbanItem {
  status: string;
  title?: string;
  done?: boolean;
  statusBadge?: {
    text: string;
    color?: string;
    icon?: string;
  };
  subtaskCount?: number;
  [key: string]: any;
}

/**
 * Configuration for kanban columns
 */
export interface KanbanColumn {
  id: string;
  title: string;
  status: string;
  maxItems?: number;
  color?: string;
  icon?: string;
}

/**
 * Configuration for item actions
 */
export interface KanbanItemAction {
  type: "remove" | "edit" | "custom";
  label?: string;
  event?: string;
  icon?: string;
}

/**
 * Drag and drop state tracking
 */
interface DragState {
  draggedItem: Cell<Charm> | null;
  draggedFromColumn: string | null;
  dragOverColumn: string | null;
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  ghostElement: HTMLElement | null;
}

/**
 * CTKanban - A kanban board component for drag-and-drop task management
 * Works with an array of Cells where each cell is rendered using ct-render
 *
 * @element ct-kanban
 *
 * @attr {Cell<Charm[]>} value - Cell containing array of charms with status property
 * @attr {string} title - Kanban board title
 * @attr {boolean} readonly - Whether the kanban is read-only
 * @attr {KanbanColumn[]} columns - Column configuration array
 * @attr {KanbanItemAction} itemAction - Item action button config
 *
 * @fires ct-item-moved - Fired when item is moved between columns with detail: { item, fromStatus, toStatus }
 * @fires ct-status-changed - Fired when item status changes with detail: { item, oldStatus, newStatus }
 * @fires ct-remove-item - Fired when removing an item with detail: { item }
 * @fires ct-edit-item - Fired when editing an item with detail: { item }
 * @fires ct-column-changed - Fired when column state changes with detail: { column, items }
 *
 * @example
 * <ct-kanban .value="${cells}" title="Sprint Board" .columns="${columns}"></ct-kanban>
 *
 * @example
 * <!-- With Cell binding -->
 * <ct-kanban .value="${cellsCell}" title="Reactive Board" readonly></ct-kanban>
 */
export class CTKanban extends BaseElement {
  @property()
  value: Cell<Charm[]> | null = null;

  @property()
  override title: string = "";

  @property()
  readonly: boolean = false;

  @property()
  columns: KanbanColumn[] = [
    { id: "todo", title: "Todo", status: "todo", color: "#fbbf24" },
    {
      id: "in-progress",
      title: "In Progress",
      status: "in-progress",
      color: "#60a5fa",
    },
    { id: "done", title: "Done", status: "done", color: "#34d399" },
  ];

  @property()
  itemAction: KanbanItemAction | null = { type: "remove" };

  // The main cell containing the array of charms
  private charmsCell: Cell<Charm[]> | null = null;
  private cellSubscription: (() => void) | null = null;

  // Drag and drop state
  private dragState: DragState = {
    draggedItem: null,
    draggedFromColumn: null,
    dragOverColumn: null,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    ghostElement: null,
  };

  // Mouse event listeners for cleanup
  private boundMouseMove = this.handleMouseMove.bind(this);
  private boundMouseUp = this.handleMouseUp.bind(this);

  constructor() {
    super();
    // We'll manage the charmsCell directly
  }

  override connectedCallback() {
    super.connectedCallback();
    // Store reference to the charms cell
    console.log("[ct-kanban] connectedCallback, value:", this.value);
    this.charmsCell = this.value;
    console.log("[ct-kanban] Set charmsCell:", this.charmsCell);
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

      --kanban-padding: 1rem;
      --kanban-gap: 1rem;
      --column-min-width: 280px;
      --column-border-radius: 0.5rem;
      --item-padding: 0.75rem;
      --item-border-radius: 0.375rem;
      --item-gap: 0.5rem;
    }

    .kanban-container {
      background-color: var(--background);
      padding: var(--kanban-padding);
    }

    .kanban-title {
      font-weight: bold;
      font-size: 1.5rem;
      margin-bottom: 1.5rem;
      color: var(--foreground);
    }

    .kanban-board {
      display: flex;
      gap: var(--kanban-gap);
      overflow-x: auto;
      overflow-y: visible;
      padding-bottom: 1rem;
    }

    .kanban-column {
      min-width: var(--column-min-width);
      background-color: var(--muted);
      border-radius: var(--column-border-radius);
      padding: 1rem;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      transition: background-color 0.2s;
    }

    .kanban-column.drag-over {
      background-color: #e0f2fe;
      border: 2px dashed var(--ring);
    }

    .column-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--border);
    }

    .column-title {
      font-weight: 600;
      font-size: 1rem;
      color: var(--foreground);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .column-icon {
      width: 1rem;
      height: 1rem;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .column-count {
      background-color: var(--background);
      color: var(--muted-foreground);
      padding: 0.25rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .column-items {
      display: flex;
      flex-direction: column;
      gap: var(--item-gap);
      flex: 1;
      min-height: 200px;
    }

    .kanban-item {
      background-color: var(--background);
      border: 1px solid var(--border);
      border-radius: var(--item-border-radius);
      padding: var(--item-padding);
      cursor: grab;
      transition: all 0.2s;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      position: relative;
      user-select: none;
    }

    .kanban-item:hover {
      border-color: var(--ring);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      transform: translateY(-1px);
    }

    .kanban-item.dragging {
      cursor: grabbing;
      opacity: 0.5;
      transform: rotate(2deg);
    }

    .kanban-item.ghost {
      position: fixed;
      z-index: 1000;
      pointer-events: none;
      transform: rotate(2deg);
      box-shadow: 0 8px 25px rgba(0, 0, 0, 0.2);
    }

    .item-content {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .item-title {
      flex: 1;
      font-weight: 500;
      color: var(--foreground);
      line-height: 1.4;
      word-break: break-word;
    }

    .item-actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .kanban-item:hover .item-actions {
      opacity: 1;
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
      transition: all 0.2s;
      border: none;
      color: white;
    }

    .item-action.remove {
      background-color: var(--destructive);
    }

    .item-action.remove:hover {
      background-color: #dc2626;
      transform: scale(1.1);
    }

    .item-action.edit {
      background-color: #3b82f6;
    }

    .item-action.edit:hover {
      background-color: #2563eb;
      transform: scale(1.1);
    }

    .item-metadata {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-top: 0.25rem;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .status-badge.todo {
      background-color: #fef3c7;
      color: #92400e;
    }

    .status-badge.in-progress {
      background-color: #dbeafe;
      color: #1e40af;
    }

    .status-badge.done {
      background-color: #d1fae5;
      color: #065f46;
    }

    .status-badge.no-status {
      background-color: #f3f4f6;
      color: #6b7280;
      border: 1px dashed #9ca3af;
    }

    .status-badge.default {
      background-color: var(--muted);
      color: var(--muted-foreground);
    }

    .subtask-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.125rem 0.375rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      background-color: #e5e7eb;
      color: #374151;
      flex-shrink: 0;
    }

    .empty-state {
      color: var(--muted-foreground);
      font-style: italic;
      text-align: center;
      padding: 2rem 1rem;
      border: 2px dashed var(--border);
      border-radius: var(--item-border-radius);
      margin-top: 0.5rem;
    }

    .column-drop-zone {
      min-height: 60px;
      border: 2px dashed transparent;
      border-radius: var(--item-border-radius);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted-foreground);
      font-size: 0.875rem;
      transition: all 0.2s;
      margin-top: 0.5rem;
    }

    .column-drop-zone.active {
      border-color: var(--ring);
      background-color: #f0f9ff;
      color: var(--ring);
    }

    /* Responsive design */
    @media (max-width: 768px) {
      .kanban-board {
        flex-direction: column;
      }

      .kanban-column {
        min-width: auto;
        width: 100%;
      }
    }
  `;

  // Lifecycle methods for Cell binding management
  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      this.charmsCell = this.value;
      this.requestUpdate();
    }
  }

  private getCharmCells(): Cell<Charm>[] {
    if (!this.charmsCell) {
      console.log("[ct-kanban] No charmsCell");
      return [];
    }

    const charms = this.charmsCell.get();
    console.log(
      "[ct-kanban] Raw charms array:",
      charms,
      "length:",
      charms?.length,
    );
    if (!Array.isArray(charms)) {
      console.log("[ct-kanban] Charms is not an array:", charms);
      return [];
    }

    const runtime = this.charmsCell.runtime;
    const space = this.charmsCell.space;

    // Create proper charm cell references from charm objects
    const charmCells = charms.map((charm, index) => {
      try {
        // First, try to create proper charm cells using entity ID
        const entityId = getEntityId(charm);
        if (entityId) {
          console.log("[ct-kanban] Found entity ID for charm:", entityId);
          const charmCell = runtime.getCellFromEntityId<Charm>(
            space,
            entityId,
            [],
            charmSchema,
          );
          return charmCell;
        }
      } catch (error) {
        console.warn("[ct-kanban] Failed to create charm cell from entity ID:", error);
      }
      
      // Fall back to array indexing approach
      console.log("[ct-kanban] Using array index approach for charm at index:", index);
      return this.charmsCell!.key(index);
    });

    console.log("[ct-kanban] Created charmCells:", charmCells.length);
    return charmCells;
  }

  private setValue(newValue: Charm[]): void {
    if (this.charmsCell) {
      this.charmsCell.set(newValue);
    }
  }

  /**
   * Get items for a specific column by status
   * Special case: status === 'no-status' returns items with no status
   */
  getColumnItems(status: string): Cell<Charm>[] {
    console.log(`[ct-kanban] Getting items for status: ${status}`);
    const charmCells = this.getCharmCells();
    console.log(`[ct-kanban] Have ${charmCells.length} charm cells to filter`);

    const filtered = charmCells.filter((charmCell) => {
      if (!charmCell) {
        console.warn("[ct-kanban] Invalid charm cell:", charmCell);
        return false;
      }

      const charm = charmCell.get();
      console.log("[ct-kanban] Charm:", charm);
      console.log("[ct-kanban] Charm type:", typeof charm);
      console.log(
        "[ct-kanban] Charm keys:",
        charm ? Object.keys(charm) : "null",
      );

      if (!charm) {
        console.warn("[ct-kanban] Charm is null/undefined");
        return false;
      }

      // Access charm status directly (not through .value.get())
      console.log("[ct-kanban] Charm status:", charm.status);

      // Handle no-status column
      if (status === "no-status") {
        const hasNoStatus = !charm.status;
        console.log(`[ct-kanban] Item has no status: ${hasNoStatus}`);
        return hasNoStatus;
      }

      const matches = charm.status === status;
      console.log(
        `[ct-kanban] Item status '${charm.status}' matches '${status}': ${matches}`,
      );
      return matches;
    });

    console.log(
      `[ct-kanban] Filtered to ${filtered.length} items for status ${status}`,
    );
    return filtered;
  }

  /**
   * Check if there are items with no status
   */
  private hasItemsWithNoStatus(): boolean {
    const charmCells = this.getCharmCells();
    console.log(
      "[ct-kanban] Checking for items with no status, have",
      charmCells.length,
      "cells",
    );

    const hasNoStatus = charmCells.some((charmCell) => {
      if (!charmCell) return false;

      const charm = charmCell.get();
      if (!charm) return false;

      // Access charm status directly (not through .value.get())
      const noStatus = !charm.status;
      if (noStatus) {
        console.log(
          "[ct-kanban] Found item with no status in hasItemsWithNoStatus:",
          charm,
        );
      }
      return noStatus;
    });

    console.log("[ct-kanban] hasItemsWithNoStatus result:", hasNoStatus);
    return hasNoStatus;
  }

  /**
   * Get all columns including automatic no-status column if needed
   */
  private getAllColumns(): KanbanColumn[] {
    const baseColumns = [...this.columns];

    // Add no-status column if there are items without status
    if (this.hasItemsWithNoStatus()) {
      const noStatusColumn: KanbanColumn = {
        id: "no-status",
        title: "No Status",
        status: "no-status",
        color: "#6b7280", // Gray color
        icon: "❓",
      };

      // Add at the beginning of the columns
      baseColumns.unshift(noStatusColumn);
    }

    return baseColumns;
  }

  /**
   * Move an item to a different column (status)
   */
  moveItem(charmCell: Cell<Charm>, toStatus: string): void {
    const charm = charmCell.get();
    if (!charm) return;

    const oldStatus = charm.status;

    // Update the charm's status directly using the cell
    // Use proper transaction-based updates
    const tx = charmCell.runtime.edit();
    if (toStatus === "no-status") {
      // Remove the status property by setting it to undefined/null
      charmCell.withTx(tx).key("status").set(undefined);
    } else {
      charmCell.withTx(tx).key("status").set(toStatus);
    }
    tx.commit();

    // Emit events
    this.emit("ct-item-moved", {
      item: charmCell,
      fromStatus: oldStatus,
      toStatus,
    });
    this.emit("ct-status-changed", {
      item: charmCell,
      oldStatus,
      newStatus: toStatus,
    });

    // Emit column change events
    this.emit("ct-column-changed", {
      column: this.columns.find((c) => c.status === toStatus),
      items: this.getColumnItems(toStatus),
    });
  }

  /**
   * Update an item's status
   */
  updateItemStatus(charmCell: Cell<Charm>, newStatus: string): void {
    this.moveItem(charmCell, newStatus);
  }

  private removeItem(charmCellToRemove: Cell<Charm>): void {
    if (!this.charmsCell) return;

    const charms = this.charmsCell.get();
    const charmToRemove = charmCellToRemove.get();
    const newCharms = charms.filter((charm) => charm !== charmToRemove);
    this.charmsCell.set(newCharms);
  }

  private handleItemAction(charmCell: Cell<Charm>, event: MouseEvent) {
    event.stopPropagation();

    if (!this.itemAction) return;

    switch (this.itemAction.type) {
      case "remove":
        this.removeItem(charmCell);
        this.emit("ct-remove-item", { item: charmCell });
        break;
      case "edit":
        this.emit("ct-edit-item", { item: charmCell });
        break;
      case "custom":
        this.emit(this.itemAction.event || "ct-action-item", {
          item: charmCell,
        });
        break;
    }
  }

  // Drag and Drop Implementation
  private handleMouseDown(charmCell: Cell<Charm>, event: MouseEvent) {
    if (this.readonly || event.button !== 0) return;

    event.preventDefault();

    const charm = charmCell.get();
    this.dragState = {
      draggedItem: charmCell,
      draggedFromColumn: charm.status,
      dragOverColumn: null,
      isDragging: true,
      dragStartX: event.clientX,
      dragStartY: event.clientY,
      ghostElement: null,
    };

    // Create ghost element
    const itemElement = event.currentTarget as HTMLElement;
    const ghost = itemElement.cloneNode(true) as HTMLElement;
    ghost.classList.add("ghost");
    ghost.style.width = `${itemElement.offsetWidth}px`;
    ghost.style.left = `${event.clientX - itemElement.offsetWidth / 2}px`;
    ghost.style.top = `${event.clientY - itemElement.offsetHeight / 2}px`;
    document.body.appendChild(ghost);
    this.dragState.ghostElement = ghost;

    // Add dragging class to original element
    itemElement.classList.add("dragging");

    // Add global event listeners
    document.addEventListener("mousemove", this.boundMouseMove);
    document.addEventListener("mouseup", this.boundMouseUp);

    this.requestUpdate();
  }

  private handleMouseMove(event: MouseEvent) {
    if (!this.dragState.isDragging || !this.dragState.ghostElement) return;

    // Update ghost position
    this.dragState.ghostElement.style.left = `${
      event.clientX - this.dragState.ghostElement.offsetWidth / 2
    }px`;
    this.dragState.ghostElement.style.top = `${
      event.clientY - this.dragState.ghostElement.offsetHeight / 2
    }px`;

    // Determine which column we're over
    const columnElements = this.shadowRoot?.querySelectorAll(".kanban-column");
    let overColumn: string | null = null;

    columnElements?.forEach((columnEl) => {
      const rect = columnEl.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        overColumn = columnEl.getAttribute("data-status");
      }
    });

    if (this.dragState.dragOverColumn !== overColumn) {
      this.dragState.dragOverColumn = overColumn;
      this.requestUpdate();
    }
  }

  private handleMouseUp(event: MouseEvent) {
    if (!this.dragState.isDragging) return;

    // Clean up ghost element
    if (this.dragState.ghostElement) {
      document.body.removeChild(this.dragState.ghostElement);
    }

    // Remove dragging class from original element
    const itemElements = this.shadowRoot?.querySelectorAll(
      ".kanban-item.dragging",
    );
    itemElements?.forEach((el) => el.classList.remove("dragging"));

    // Remove global event listeners
    document.removeEventListener("mousemove", this.boundMouseMove);
    document.removeEventListener("mouseup", this.boundMouseUp);

    // Handle drop if we have a valid target
    if (
      this.dragState.draggedItem &&
      this.dragState.dragOverColumn &&
      this.dragState.dragOverColumn !== this.dragState.draggedFromColumn
    ) {
      this.moveItem(
        this.dragState.draggedItem as Cell<Charm>,
        this.dragState.dragOverColumn,
      );
    }

    // Reset drag state
    this.dragState = {
      draggedItem: null,
      draggedFromColumn: null,
      dragOverColumn: null,
      isDragging: false,
      dragStartX: 0,
      dragStartY: 0,
      ghostElement: null,
    };

    this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up any remaining event listeners
    document.removeEventListener("mousemove", this.boundMouseMove);
    document.removeEventListener("mouseup", this.boundMouseUp);

    // Clean up ghost element if it exists
    if (this.dragState.ghostElement) {
      document.body.removeChild(this.dragState.ghostElement);
    }
  }

  private getStatusCssClass(status: string): string {
    switch (status) {
      case "todo":
        return "todo";
      case "in-progress":
        return "in-progress";
      case "done":
        return "done";
      case "no-status":
        return "no-status";
      default:
        return "default";
    }
  }

  private getItemActionIcon(actionType: string): string {
    switch (actionType) {
      case "remove":
        return "×";
      case "edit":
        return "✎";
      default:
        return "•";
    }
  }

  private getItemActionTitle(actionType: string): string {
    switch (actionType) {
      case "remove":
        return "Remove item";
      case "edit":
        return "Edit item";
      default:
        return "Action";
    }
  }

  override render() {
    console.log("[ct-kanban] Rendering, charmsCell:", this.charmsCell);
    const charmCells = this.getCharmCells();
    console.log("[ct-kanban] Got charmCells:", charmCells.length);

    const allColumns = this.getAllColumns();
    console.log("[ct-kanban] All columns:", allColumns.map((c) => c.title));

    return html`
      <div class="kanban-container">
        ${this.title
        ? html`
          <h2 class="kanban-title">${this.title}</h2>
        `
        : ""}

        <div class="kanban-board">
          ${this.getAllColumns().map((column) =>
        this.renderColumn(column, charmCells)
      )}
        </div>
      </div>
    `;
  }

  private renderColumn(column: KanbanColumn, allItems: Cell<Charm>[]) {
    const columnItems = this.getColumnItems(column.status);
    const isDragOver = this.dragState.dragOverColumn === column.status;
    const isMaxReached = column.maxItems &&
      columnItems.length >= column.maxItems;

    return html`
      <div
        class="kanban-column ${isDragOver ? "drag-over" : ""}"
        data-status="${column.status}"
      >
        <div class="column-header">
          <div class="column-title">
            ${column.icon
        ? html`
          <span class="column-icon" style="background-color: ${column.color ||
            "#94a3b8"}"></span>
        `
        : ""} ${column.title}
          </div>
          <div class="column-count">
            ${columnItems.length}${column.maxItems ? `/${column.maxItems}` : ""}
          </div>
        </div>

        <div class="column-items">
          ${columnItems.length === 0
        ? html`
          <div class="empty-state">
            ${isDragOver ? "Drop item here" : "No items"}
          </div>
        `
        : repeat(
          columnItems,
          (charmCell) => {
            const charm = charmCell.get();
            return `${
              charm.title || charmId(charmCell) || "item"
            }-${charm.status}`;
          }, // Use title + status as key
          (charmCell) => this.renderItem(charmCell),
        )} ${this.dragState.isDragging && !isDragOver
        ? html`
          <div class="column-drop-zone ${isDragOver ? "active" : ""}">
            Drop here
          </div>
        `
        : ""}
        </div>
      </div>
    `;
  }

  private renderItem(charmCell: Cell<Charm>) {
    const isDragging = this.dragState.draggedItem === charmCell;

    return html`
      <div
        class="kanban-item ${isDragging ? "dragging" : ""}"
        @mousedown="${(e: MouseEvent) => this.handleMouseDown(charmCell, e)}"
      >
        <div class="item-content">
          <div class="item-title">
            <ct-render .cell="${charmCell}"></ct-render>
          </div>

          ${!this.readonly && this.itemAction
        ? html`
          <div class="item-actions">
            <button
              class="item-action ${this.itemAction.type}"
              @click="${(e: MouseEvent) => this.handleItemAction(charmCell, e)}"
              title="${this.getItemActionTitle(this.itemAction.type)}"
            >
              ${this.getItemActionIcon(this.itemAction.type)}
            </button>
          </div>
        `
        : ""}
        </div>

        ${this.renderItemMetadata(charmCell)}
      </div>
    `;
  }

  private renderItemMetadata(charmCell: Cell<Charm>) {
    const charm = charmCell.get();
    const hasStatusBadge = charm.statusBadge || charm.status;
    const hasSubtasks = charm.subtaskCount ||
      (charm.items && charm.items.length > 0);

    if (!hasStatusBadge && !hasSubtasks) return "";

    return html`
      <div class="item-metadata">
        ${hasStatusBadge ? this.renderStatusBadge(charmCell) : ""} ${hasSubtasks
        ? this.renderSubtaskBadge(charmCell)
        : ""}
      </div>
    `;
  }

  private renderStatusBadge(charmCell: Cell<Charm>) {
    const charm = charmCell.get();
    const status = charm.status || "no-status";
    const badge = charm.statusBadge || {
      text: status === "no-status" ? "No Status" : status,
      icon: this.getDefaultStatusIcon(status),
    };
    const cssClass = this.getStatusCssClass(status);

    return html`
      <span class="status-badge ${cssClass}">
        ${badge.icon
        ? html`
          <span>${badge.icon}</span>
        `
        : ""} ${badge.text}
      </span>
    `;
  }

  private renderSubtaskBadge(charmCell: Cell<Charm>) {
    const charm = charmCell.get();
    const subtaskCount = charm.subtaskCount ||
      (charm.items ? charm.items.length : 0);
    if (subtaskCount === 0) return "";

    return html`
      <span class="subtask-badge">
        <span>📋</span>
        ${subtaskCount}
      </span>
    `;
  }

  private getDefaultStatusIcon(status?: string): string {
    switch (status) {
      case "todo":
        return "📋";
      case "in-progress":
        return "⚡";
      case "done":
        return "✅";
      case "no-status":
        return "❓";
      default:
        return "📄";
    }
  }
}

globalThis.customElements.define("ct-kanban", CTKanban);
