import { css, html, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { consume } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import "../ct-chip/ct-chip.ts";
import {
  type CellHandle,
  CellRef,
  NAME,
  parseLLMFriendlyLink,
  type RuntimeClient,
} from "@commontools/runtime-client";
import type { DID } from "@commontools/identity";
import { runtimeContext, spaceContext } from "../../runtime-context.ts";
import { appViewToUrlPath, navigate } from "@commontools/shell/shared";
import {
  createDragPreview,
  endDrag,
  startDrag,
  updateDragPointer,
} from "../../core/drag-state.ts";

/**
 * CTCellLink - Renders a link or cell as a clickable, draggable pill
 *
 * Every cell link is a drag source by default. Set `static` to suppress
 * drag behavior (used in drag previews to avoid recursion).
 *
 * @element ct-cell-link
 *
 * @property {string} link - The serialized path to a cell (e.g. /of:bafy.../path)
 * @property {CellHandle} cell - The live Cell reference
 * @property {boolean} static - Suppress drag behavior
 *
 * @example
 * <ct-cell-link .link=${"/of:bafy.../path"}></ct-cell-link>
 * <ct-cell-link .cell=${myCell}></ct-cell-link>
 * <ct-cell-link .cell=${myCell} static></ct-cell-link>
 */
export class CTCellLink extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        vertical-align: middle;
      }

      ct-chip {
        cursor: pointer;
        max-width: 100%;
      }

      :host(.dragging) ct-chip {
        cursor: grabbing;
        opacity: 0.5;
      }
    `,
  ];

  @property({ type: String })
  link?: string;

  @property({ type: String })
  label?: string;

  @property({ attribute: false })
  cell?: CellHandle;

  @property({ type: Boolean, reflect: true, attribute: "static" })
  isStatic?: boolean;

  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  runtime?: RuntimeClient;

  @consume({ context: spaceContext, subscribe: true })
  @property({ attribute: false })
  space?: DID;

  @state()
  private _resolvedCell?: CellHandle;

  @state()
  private _name?: string;

  @state()
  private _handle?: string;

  private _unsubscribe?: () => void;

  // Drag state
  private _isDragging = false;
  private _isTracking = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _pointerId?: number;
  private _preview?: HTMLElement;
  private _boundPointerMove = this._onPointerMove.bind(this);
  private _boundPointerUp = this._onPointerUp.bind(this);

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupSubscription();
    this._endDrag();
  }

  private _cleanupSubscription() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
  }

  private _endDrag() {
    document.removeEventListener("pointermove", this._boundPointerMove);
    document.removeEventListener("pointerup", this._boundPointerUp);
    document.removeEventListener("pointercancel", this._boundPointerUp);

    if (this._isDragging) {
      endDrag();
      this.classList.remove("dragging");
    }

    this._isDragging = false;
    this._isTracking = false;
    this._pointerId = undefined;
    this._preview = undefined;
  }

  protected override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    if (
      changedProperties.has("cell") || changedProperties.has("link") ||
      changedProperties.has("runtime") || changedProperties.has("space")
    ) {
      this._resolveCell();
    }
  }

  protected override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);

    if (changedProperties.has("_resolvedCell")) {
      this._updateSubscription();
      this._updateDisplayInfo();
    }

    // Also update display info when link changes without resolving to a new cell
    if (
      changedProperties.has("link") && !changedProperties.has("_resolvedCell")
    ) {
      this._updateDisplayInfo();
    }
  }

  private async _resolveCell() {
    if (this.cell) {
      this._resolvedCell = await this.cell.resolveAsCell();
      return;
    }

    if (this.link && this.runtime) {
      try {
        // TODO(runtime-worker-refactor): Making some changes here, but
        // `this.space` will be Shell's active space, not necessarily the
        // space for `this.link`.
        const parsedLink = parseLLMFriendlyLink(this.link, this.space);
        if (!parsedLink.space) {
          throw new Error("Link missing space.");
        }
        const cell = this.runtime.getCellFromRef(parsedLink as CellRef);
        this._resolvedCell = await cell.resolveAsCell();
      } catch (e) {
        console.error("Failed to resolve link:", e);
        this._resolvedCell = undefined;
      }
    } else {
      this._resolvedCell = undefined;
    }
  }

  private _updateSubscription() {
    this._cleanupSubscription();

    if (this._resolvedCell) {
      // Subscribe to the cell to get updates for NAME
      this._unsubscribe = this._resolvedCell.subscribe((val) => {
        this._updateNameFromValue(val);
      });
    }
  }

  private _updateNameFromValue(val: unknown) {
    if (val && typeof val === "object" && NAME in val) {
      this._name = (val as any)[NAME];
    } else {
      this._name = undefined;
    }
    this.requestUpdate();
  }

  private _updateDisplayInfo() {
    if (this._resolvedCell) {
      const shortId = this._resolvedCell.id().slice(-6);
      this._handle = `#${shortId}`;
    } else if (this.link) {
      // Fallback if we can't resolve the cell but have a link string
      try {
        const parsed = parseLLMFriendlyLink(this.link);
        const id = parsed.id;
        const shortId = id ? id.split(":").pop()?.slice(0, 6) ?? "???" : "???";
        this._handle = `#${shortId}`;
      } catch {
        this._handle = this.link;
      }
    } else {
      this._handle = undefined;
    }
  }

  private _onPointerDown(e: PointerEvent) {
    if (this.isStatic || !this._resolvedCell) return;

    // Prevent parent ct-drag-source elements from also starting a drag
    e.stopPropagation();

    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;
    this._pointerId = e.pointerId;
    this._isTracking = true;

    document.addEventListener("pointermove", this._boundPointerMove);
    document.addEventListener("pointerup", this._boundPointerUp);
    document.addEventListener("pointercancel", this._boundPointerUp);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._isTracking || e.pointerId !== this._pointerId) return;

    const dx = e.clientX - this._dragStartX;
    const dy = e.clientY - this._dragStartY;

    if (!this._isDragging && Math.sqrt(dx * dx + dy * dy) > 5) {
      this._isDragging = true;
      this._beginDrag(e);
    }

    if (this._isDragging && this._preview) {
      this._preview.style.left = `${e.clientX + 10}px`;
      this._preview.style.top = `${e.clientY + 10}px`;
      updateDragPointer(e.clientX, e.clientY);
    }
  }

  private _onPointerUp(e: PointerEvent) {
    if (e.pointerId !== this._pointerId) return;
    this._endDrag();
  }

  private _beginDrag(e: PointerEvent) {
    if (!this._resolvedCell) return;

    this.classList.add("dragging");

    const preview = createDragPreview(this._resolvedCell);
    document.body.appendChild(preview);

    preview.style.left = `${e.clientX + 10}px`;
    preview.style.top = `${e.clientY + 10}px`;
    this._preview = preview;

    startDrag({
      cell: this._resolvedCell,
      type: "cell-link",
      sourceElement: this,
      preview,
      pointerX: e.clientX,
      pointerY: e.clientY,
    });
  }

  private _handleClick(e: MouseEvent) {
    if (this._isDragging) return;
    e.stopPropagation();
    if (this._resolvedCell) {
      if (this._resolvedCell.ref().path.length > 0) {
        throw new Error(
          "Attempted to navigate to a cell that isn't a root cell",
        );
      }

      // TODO(runtime-worker-refactor):
      const view = {
        spaceDid: this._resolvedCell.space(),
        pieceId: this._resolvedCell.id(),
      };

      // Cmd (Mac) or Ctrl (Windows/Linux) opens in new tab
      if (e.metaKey || e.ctrlKey) {
        const url = appViewToUrlPath(view);
        globalThis.open(url, "_blank");
      } else {
        navigate(view);
      }
    }
  }

  override render() {
    // Priority: label (from markdown) > [NAME] field > handle > "Unknown Link"
    const displayText = this.label
      ? this.label
      : this._name
      ? `${this._name} ${this._handle}`
      : (this._handle || "Unknown Link");

    return html`
      <ct-chip
        variant="primary"
        interactive
        @pointerdown="${this._onPointerDown}"
        @click="${this._handleClick}"
      >
        ${displayText}
      </ct-chip>
    `;
  }
}

globalThis.customElements.define("ct-cell-link", CTCellLink);

declare global {
  interface HTMLElementTagNameMap {
    "ct-cell-link": CTCellLink;
  }
}
