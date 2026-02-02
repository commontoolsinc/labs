import { css, html, PropertyValues } from "lit";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { render } from "@commontools/html/client";
import type { CellHandle } from "@commontools/runtime-client";
import { type VNode } from "@commontools/runtime-client";
import "../ct-loader/ct-loader.ts";

// Set to true to enable debug logging
const DEBUG_LOGGING = false;

/**
 * UI variant types for rendering different representations of a piece.
 * Each variant maps to a property name that patterns can export.
 *
 * - `default`: The main [UI] export. Full standalone rendering.
 * - `preview`: Compact preview for pickers/lists (e.g., ct-picker). Maps to `previewUI`.
 * - `thumbnail`: Icon/thumbnail view for grid displays. Maps to `thumbnailUI`.
 * - `sidebar`: Optimized layout for sidebar/navigation contexts. Maps to `sidebarUI`.
 * - `fab`: Floating action button UI. Maps to `fabUI`.
 * - `embedded`: Minimal UI without chrome for embedding in containers. Maps to `embeddedUI`.
 *              Used when a pattern is rendered as a module inside another pattern (e.g., Note in Record).
 */
export type UIVariant =
  | "default"
  | "preview"
  | "thumbnail"
  | "sidebar"
  | "fab"
  | "embedded"
  | "settings";

/**
 * Maps variant names to the property key to look for on the piece.
 * null means use the default [UI] rendering via render().
 */
const _VARIANT_TO_KEY: Record<UIVariant, VariantCellKey | null> = {
  default: null,
  preview: "previewUI",
  thumbnail: "thumbnailUI",
  sidebar: "sidebarUI",
  fab: "fabUI",
  embedded: "embeddedUI",
  settings: "settingsUI",
};

type VariantCellKey =
  | "previewUI"
  | "thumbnailUI"
  | "sidebarUI"
  | "fabUI"
  | "embeddedUI"
  | "settingsUI";

/**
 * CTRender - Renders a cell that contains a piece pattern with UI
 *
 * @element ct-render
 *
 * @property {CellHandle} cell - The cell containing the piece to render
 * @property {UIVariant} variant - UI variant to render: "default" | "preview" | "thumbnail" | "sidebar" | "fab" | "settings" | "embedded"
 *   Each variant maps to a property on the piece (e.g., "preview" -> "previewUI", "embedded" -> "embeddedUI").
 *   Falls back to default [UI] if the variant property doesn't exist.
 *
 * @example
 * // Default rendering
 * <ct-render .cell=${myPieceCell}></ct-render>
 *
 * @example
 * // Render preview variant (uses previewUI if available, falls back to [UI])
 * <ct-render .cell=${myPieceCell} variant="preview"></ct-render>
 *
 * @example
 * // Render embedded variant (uses embeddedUI - minimal UI without chrome)
 * <ct-render .cell=${notePiece} variant="embedded"></ct-render>
 */
export class CTRender extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .render-container {
      display: flex;
      flex-direction: column;
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
    variant: { type: String },
  };

  declare cell: CellHandle;
  declare variant: UIVariant | undefined;

  // Use Lit ref directive for stable container reference across re-renders
  private _containerRef: Ref<HTMLDivElement> = createRef();

  private _cleanup?: () => void;
  // Track the cell ID we're currently rendering to detect stale renders
  private _renderingCellId?: string;

  @state()
  private _hasRendered = false;
  private _startPromise?: Promise<boolean>;

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
    // traversing [UI] with a CellHandle, so we don't need to wrap here
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

    const cellChanged = changedProperties.has("cell");
    const variantChanged = changedProperties.has("variant");

    if (cellChanged || variantChanged) {
      let shouldRerender = false;

      if (cellChanged) {
        const oldCell = changedProperties.get("cell") as CellHandle | undefined;
        // Only re-render if the cell actually changed
        shouldRerender = !oldCell || !this.cell || !oldCell.equals(this.cell);
        this._log("cell property changed, should rerender:", shouldRerender);

        if (shouldRerender) {
          // Reset render state when cell changes - ensures we'll render the new cell
          this._hasRendered = false;
        }
      }

      if (variantChanged) {
        const oldVariant = changedProperties.get("variant") as
          | UIVariant
          | undefined;
        if (oldVariant !== this.variant) {
          shouldRerender = true;
          this._log("variant changed:", oldVariant, "->", this.variant);
        }
      }

      if (shouldRerender) {
        this._log("re-rendering due to cell or variant change");
        this._renderCell();
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
      if (this._renderingCellId !== cellId) {
        this._log("cell changed during render, aborting");
        return;
      }

      // only await when using variants
      if (this.variant && this.variant !== "default") {
        await this._startPromise;
        await this.cell.sync();
      }

      // @TODO(runtime-worker-refactor): We must type all renderable cells
      // as potentially having these variant keys?
      const variantKey = undefined; //VARIANT_TO_KEY[this.variant ?? "default"];
      const renderCell = variantKey ? this.cell.key(variantKey) : this.cell;
      this._log("rendering UI into container");
      this._cleanup = render(container, renderCell as CellHandle<VNode>);
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
    this._renderingCellId = undefined;
    this._hasRendered = false;
    this._cleanupRender();
  }
}

globalThis.customElements.define("ct-render", CTRender);
