import { css, html, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import "../ct-chip/ct-chip.ts";
import type { Cell, IRuntime, MemorySpace } from "@commontools/runner";
import { NAME } from "@commontools/runner";
import { parseLLMFriendlyLink } from "@commontools/runner";

/**
 * CTCellLink - Renders a link or cell as a clickable pill
 *
 * @element ct-cell-link
 *
 * @property {string} link - The serialized path to a cell (e.g. /of:bafy.../path)
 * @property {Cell} cell - The live Cell reference
 * @property {IRuntime} runtime - The runtime instance (required for resolving links and navigation)
 * @property {MemorySpace} space - The memory space (optional, used when resolving links)
 *
 * @example
 * <ct-cell-link .link=${"/of:bafy.../path"} .runtime=${runtime}></ct-cell-link>
 * <ct-cell-link .cell=${myCell}></ct-cell-link>
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
    `,
  ];

  @property({ type: String })
  link?: string;

  @property({ attribute: false })
  cell?: Cell;

  @property({ attribute: false })
  runtime?: IRuntime;

  @property({ attribute: false })
  space?: MemorySpace;

  @state()
  private _resolvedCell?: Cell;

  @state()
  private _name?: string;

  @state()
  private _handle?: string;

  private _unsubscribe?: () => void;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupSubscription();
  }

  private _cleanupSubscription() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
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
  }

  private _resolveCell() {
    if (this.cell) {
      this._resolvedCell = this.cell;
      return;
    }

    if (this.link && this.runtime) {
      try {
        const parsedLink = parseLLMFriendlyLink(this.link, this.space);
        // We need to cast because parseLLMFriendlyLink returns NormalizedLink (if space optional)
        // but getCellFromLink might expect NormalizedFullLink or handle it.
        // Based on runtime.ts, getCellFromLink handles NormalizedLink but casts to NormalizedFullLink internally for createCell.
        // If space is missing in parsedLink, createCell might fail if it strictly needs it.
        // However, we pass what we have.
        this._resolvedCell = this.runtime.getCellFromLink(parsedLink);
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
      // We assume the cell value is an object that might have NAME symbol
      this._unsubscribe = this._resolvedCell.sink((val) => {
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
      const link = this._resolvedCell.getAsNormalizedFullLink();
      // Create a short handle from the ID
      const id = link.id;
      const shortId = id.split(":").pop()?.slice(0, 6) ?? "???";
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

  private _handleClick(e: Event) {
    e.stopPropagation();
    if (this._resolvedCell && this._resolvedCell.runtime) {
      this._resolvedCell.runtime.navigateCallback?.(this._resolvedCell);
    } else if (this.runtime && this._resolvedCell) {
      this.runtime.navigateCallback?.(this._resolvedCell);
    }
  }

  override render() {
    const displayText = this._name
      ? `${this._name} ${this._handle}`
      : (this._handle || "Unknown Link");

    return html`
      <ct-chip
        variant="primary"
        interactive
        @click="${this._handleClick}"
      >
        ${displayText}
      </ct-chip>
    `;
  }
}

globalThis.customElements.define("ct-cell-link", CTCellLink);
