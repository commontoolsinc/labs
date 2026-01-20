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

/**
 * CTCellLink - Renders a link or cell as a clickable pill
 *
 * @element ct-cell-link
 *
 * @property {string} link - The serialized path to a cell (e.g. /of:bafy.../path)
 * @property {Cell} cell - The live Cell reference
 *
 * @example
 * <ct-cell-link .link=${"/of:bafy.../path"}></ct-cell-link>
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

  @property({ type: String })
  label?: string;

  @property({ attribute: false })
  cell?: CellHandle;

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

    // Also update display info when link changes without resolving to a new cell
    if (
      changedProperties.has("link") && !changedProperties.has("_resolvedCell")
    ) {
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
        // TODO(runtime-worker-refactor): Making some changes here, but
        // `this.space` will be Shell's active space, not necessarily the
        // space for `this.link`.
        const parsedLink = parseLLMFriendlyLink(this.link, this.space);
        if (!parsedLink.space) {
          throw new Error("Link missing space.");
        }
        this._resolvedCell = this.runtime.getCellFromRef(
          parsedLink as CellRef,
        );
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

  private _handleClick(e: MouseEvent) {
    e.stopPropagation();
    // @TODO(runtime-worker-refactor)
    if (this._resolvedCell) {
      const view = {
        spaceDid: this._resolvedCell.space(),
        charmId: this._resolvedCell.id(),
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
