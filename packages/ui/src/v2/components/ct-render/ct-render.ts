import { css, html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { render } from "@commontools/html";
import type { Cell } from "@commontools/runner";
import { getRecipeIdFromCharm } from "@commontools/charm";
import { type VNode } from "@commontools/runner";
import "../ct-loader/ct-loader.ts";

// Set to true to enable debug logging
const DEBUG_LOGGING = false;

/**
 * UI variant types for rendering different representations of a charm.
 * Each variant maps to a property name that patterns can export.
 *
 * - `default`: The main [UI] export. Full standalone rendering.
 * - `preview`: Compact preview for pickers/lists (e.g., ct-picker). Maps to `previewUI`.
 * - `thumbnail`: Icon/thumbnail view for grid displays. Maps to `thumbnailUI`.
 * - `sidebar`: Optimized layout for sidebar/navigation contexts. Maps to `sidebarUI`.
 * - `fab`: Floating action button UI. Maps to `fabUI`.
 * - `settings`: Configuration/settings panel (shown in modals). Maps to `settingsUI`.
 * - `embedded`: Minimal UI without chrome for embedding in containers. Maps to `embeddedUI`.
 *              Used when a pattern is rendered as a module inside another pattern (e.g., Note in Record).
 */
export type UIVariant =
  | "default"
  | "preview"
  | "thumbnail"
  | "sidebar"
  | "fab"
  | "settings"
  | "embedded";

/**
 * Maps variant names to the property key to look for on the charm.
 * null means use the default [UI] rendering via render().
 */
const VARIANT_TO_KEY: Record<UIVariant, string | null> = {
  default: null,
  preview: "previewUI",
  thumbnail: "thumbnailUI",
  sidebar: "sidebarUI",
  fab: "fabUI",
  settings: "settingsUI",
  embedded: "embeddedUI",
};

/**
 * CTRender - Renders a cell that contains a charm recipe with UI
 *
 * @element ct-render
 *
 * @property {Cell} cell - The cell containing the charm to render
 * @property {UIVariant} variant - UI variant to render: "default" | "preview" | "thumbnail" | "sidebar" | "fab" | "settings" | "embedded"
 *   Each variant maps to a property on the charm (e.g., "preview" -> "previewUI", "embedded" -> "embeddedUI").
 *   Falls back to default [UI] if the variant property doesn't exist.
 *
 * @example
 * // Default rendering
 * <ct-render .cell=${myCharmCell}></ct-render>
 *
 * @example
 * // Render preview variant (uses previewUI if available, falls back to [UI])
 * <ct-render .cell=${myCharmCell} variant="preview"></ct-render>
 *
 * @example
 * // Render embedded variant (uses embeddedUI - minimal UI without chrome)
 * <ct-render .cell=${noteCharm} variant="embedded"></ct-render>
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
    }
  `;

  static override properties = {
    cell: { attribute: false },
    variant: { type: String },
  };

  declare cell: Cell;
  declare variant: UIVariant | undefined;

  private _renderContainer?: HTMLDivElement;
  private _cleanup?: () => void;
  private _isRenderInProgress = false;
  private _hasRendered = false;

  // Debug helpers
  private _instanceId = DEBUG_LOGGING
    ? Math.random().toString(36).substring(7)
    : "";
  private _log(...args: any[]) {
    if (DEBUG_LOGGING) {
      console.log(`[ct-render ${this._instanceId}]`, ...args);
    }
  }

  protected override render() {
    // Note: ct-cell-context is now auto-injected by the renderer when
    // traversing [UI] with a Cell, so we don't need to wrap here
    return html`
      ${!this._hasRendered
        ? html`
          <div class="loading-spinner">
            <ct-loader size="lg"></ct-loader>
          </div>
        `
        : null}
      <div class="render-container"></div>
    `;
  }

  protected override firstUpdated() {
    this._log("firstUpdated called");
    this._renderContainer = this.shadowRoot?.querySelector(
      ".render-container",
    ) as HTMLDivElement;

    // Skip initial render if cell is already set - updated() will handle it
    if (!this.cell) {
      this._renderCell();
    }
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
        const oldCell = changedProperties.get("cell") as Cell | undefined;
        // Only re-render if the cell actually changed
        shouldRerender = !oldCell || !this.cell || !oldCell.equals(this.cell);
        this._log("cell property changed, should rerender:", shouldRerender);
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

  private async _loadAndRenderRecipe(
    recipeId: string,
    retry: boolean = true,
  ) {
    try {
      this._log("loading recipe:", recipeId);

      // Load and run the recipe
      const recipe = await this.cell.runtime.recipeManager.loadRecipe(
        recipeId,
        this.cell.space,
      );
      await this.cell.runtime.runSynced(this.cell, recipe);

      await this._renderUiFromCell(this.cell);
    } catch (error) {
      if (retry) {
        console.warn("Failed to load recipe, retrying...");
        // First failure, sync and retry once
        await this.cell.sync();
        await this._loadAndRenderRecipe(recipeId, false);
      } else {
        // Second failure, give up
        throw error;
      }
    }
  }

  private async _renderUiFromCell(cell: Cell<unknown>) {
    if (!this._renderContainer) {
      throw new Error("Render container not found");
    }

    await cell.sync();

    // Resolve UI variant with fallback to default [UI]
    let uiCell: Cell<unknown> = cell;

    if (this.variant && this.variant !== "default") {
      const variantKey = VARIANT_TO_KEY[this.variant];
      if (variantKey) {
        const variantCell = cell.key(variantKey);
        const variantValue = variantCell?.get();
        if (variantValue !== undefined && variantValue !== null) {
          uiCell = variantCell;
          this._log("using variant:", this.variant, "->", variantKey);
        } else {
          this._log("variant not found, falling back to [UI]:", this.variant);
        }
      }
    }

    this._log("rendering UI");
    this._cleanup = render(this._renderContainer, uiCell as Cell<VNode>);
  }

  private _isSubPath(cell: Cell<unknown>): boolean {
    const link = cell.getAsNormalizedFullLink();
    return Array.isArray(link?.path) && link.path.length > 0;
  }

  private async _renderCell() {
    this._log("_renderCell called");

    // Prevent concurrent renders
    if (this._isRenderInProgress) {
      this._log("render already in progress, skipping");
      return;
    }

    // Early exits
    if (!this._renderContainer || !this.cell) {
      this._log("missing container or cell, returning");
      return;
    }

    // Mark render as in progress
    this._isRenderInProgress = true;
    try {
      // Clean up any previous render
      this._cleanupPreviousRender();

      const isSubPath = this._isSubPath(this.cell);

      if (isSubPath) {
        this._log("cell is a subpath, rendering directly");
        await this._renderUiFromCell(this.cell);
      } else {
        const recipeId = getRecipeIdFromCharm(this.cell);
        if (recipeId) {
          await this._loadAndRenderRecipe(recipeId);
        } else {
          this._log("no recipe id found, rendering cell directly");
          await this._renderUiFromCell(this.cell);
        }
      }

      // Mark as rendered and trigger re-render to hide spinner
      this._hasRendered = true;
      this.requestUpdate();
    } catch (error) {
      this._handleRenderError(error);
    } finally {
      this._isRenderInProgress = false;
    }
  }

  private _cleanupPreviousRender() {
    if (this._cleanup) {
      this._log("cleaning up previous render");
      this._cleanup();
      this._cleanup = undefined;
    }
  }

  private _handleRenderError(error: unknown) {
    console.error("[ct-render] Error rendering cell:", error);

    if (this._renderContainer) {
      this._renderContainer.innerHTML =
        `<div style="color: var(--ct-color-destructive)">Error rendering content: ${
          error instanceof Error ? error.message : "Unknown error"
        }</div>`;
    }
  }

  override disconnectedCallback() {
    this._log("disconnectedCallback called");
    super.disconnectedCallback();

    // Cancel any in-progress renders
    this._isRenderInProgress = false;

    // Clean up
    this._cleanupPreviousRender();
  }
}

globalThis.customElements.define("ct-render", CTRender);

declare global {
  interface HTMLElementTagNameMap {
    "ct-render": CTRender;
  }
}
