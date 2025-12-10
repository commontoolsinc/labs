import { css, html, PropertyValues } from "lit";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { render } from "@commontools/html";
import type { RemoteCell } from "@commontools/runner/worker";
import { type VNode } from "@commontools/runner";
import "../ct-loader/ct-loader.ts";

// Set to true to enable debug logging
const DEBUG_LOGGING = false;

/**
 * CTRender - Renders a cell that contains a charm recipe with UI
 *
 * @element ct-render
 *
 * @property {RemoteCell} cell - The cell containing the charm to render
 *
 * @example
 * <ct-render .cell=${myCharmCell}></ct-render>
 */
export class CTRender extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .render-container {
      width: 100%;
      height: 100%;
    }

    .loading-spinner {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }

    :host {
      position: relative;
    }
  `;

  static override properties = {
    cell: { attribute: false },
  };

  declare cell: RemoteCell;

  // Use Lit ref directive for stable container reference across re-renders
  private _containerRef: Ref<HTMLDivElement> = createRef();

  private _cleanup?: () => void;
  // Track the cell ID we're currently rendering to detect stale renders
  private _renderingCellId?: string;

  @state()
  private _hasRendered = false;

  // Debug helpers
  private _instanceId = DEBUG_LOGGING
    ? Math.random().toString(36).substring(7)
    : "";
  private _log(...args: unknown[]) {
    if (DEBUG_LOGGING) {
      console.log(`[ct-render ${this._instanceId}]`, ...args);
    }
  }

  protected override render() {
    // Note: ct-cell-context is now auto-injected by the renderer when
    // traversing [UI] with a RemoteCell, so we don't need to wrap here
    return html`
      ${!this._hasRendered
        ? html`
          <div class="loading-spinner">
            <ct-loader size="lg"></ct-loader>
          </div>
        `
        : null}
      <div class="render-container" ${ref(this._containerRef)}></div>
    `;
  }

  protected override updated(changedProperties: PropertyValues) {
    this._log(
      "updated called, changedProperties:",
      Array.from(changedProperties.keys()),
    );

    if (changedProperties.has("cell")) {
      const oldCell = changedProperties.get("cell") as RemoteCell | undefined;

      // Only re-render if the cell actually changed
      const shouldRerender = !oldCell || !this.cell ||
        !oldCell.equals(this.cell);

      if (shouldRerender) {
        this._log(
          "cells are different, calling _renderCell",
          oldCell,
          this.cell,
        );
        this._renderCell();
      } else {
        this._log("cells are equal, skipping _renderCell", oldCell, this.cell);
      }
    }
  }

  private async _renderCell() {
    const container = this._containerRef.value;
    const cellId = this.cell.id();
    this._renderingCellId = cellId;

    this._log(`_renderCell called: ${cellId}`);

    if (!container || !this.cell) {
      return;
    }

    this._cleanupRender();

    try {
      // If not a subpath, need to run the charm first
      if (!isSubPath(this.cell)) {
        await this.cell.runtime().runCharmSynced(cellId);
      }

      // Check if cell changed during async operation
      if (this._renderingCellId !== cellId) {
        this._log("cell changed during render setup, aborting");
        return;
      }

      // Sync and render
      await this.cell.sync();

      // Check again after sync
      if (this._renderingCellId !== cellId) {
        this._log("cell changed during sync, aborting");
        return;
      }

      this._log("rendering UI into container");
      this._cleanup = render(container, this.cell as RemoteCell<VNode>);
      this._hasRendered = true;
    } catch (error) {
      // Only show error if we're still rendering this cell
      if (this._renderingCellId === cellId) {
        this._handleRenderError(error);
      }
    }
  }

  private _cleanupRender() {
    if (this._cleanup) {
      this._log("cleaning up previous render");
      this._cleanup();
      this._cleanup = undefined;
    }
  }

  private _handleRenderError(error: unknown) {
    console.error("[ct-render] Error rendering cell:", error);

    const container = this._containerRef.value;
    if (container) {
      container.innerHTML =
        `<div style="color: var(--ct-color-destructive)">Error rendering content: ${
          error instanceof Error ? error.message : "Unknown error"
        }</div>`;
    }
  }

  override disconnectedCallback() {
    this._log("disconnectedCallback called");
    super.disconnectedCallback();

    // Invalidate any in-progress render
    this._renderingCellId = undefined;

    // Clean up
    this._cleanupRender();
  }
}

globalThis.customElements.define("ct-render", CTRender);

function isSubPath(cell: RemoteCell<unknown>): boolean {
  const link = cell.getAsNormalizedFullLink();
  return Array.isArray(link?.path) && link.path.length > 0;
}
