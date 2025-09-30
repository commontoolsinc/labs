import { css, html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { render } from "@commontools/html";
import { isCell, UI } from "@commontools/runner";
import type { Cell } from "@commontools/runner";
import { getIframeRecipe, getRecipeIdFromCharm } from "@commontools/charm";

// Set to true to enable debug logging
const DEBUG_LOGGING = false;

/**
 * CTRender - Renders a cell that contains a charm recipe with UI
 *
 * @element ct-render
 *
 * @property {Cell} cell - The cell containing the charm to render
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
    }

    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--ct-color-border, #e0e0e0);
      border-top-color: var(--ct-color-primary, #000);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;

  static override properties = {
    cell: { attribute: false },
  };

  declare cell: Cell;

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
    return html`
      ${!this._hasRendered
        ? html`
          <div class="loading-spinner">
            <div class="spinner"></div>
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

    if (changedProperties.has("cell")) {
      const oldCell = changedProperties.get("cell") as Cell | undefined;

      // Only re-render if the cell actually changed
      // Check if both cells exist and are equal, or if one doesn't exist
      const shouldRerender = !oldCell || !this.cell ||
        !oldCell.equals(this.cell);

      this._log("cell property changed, should rerender:", shouldRerender);

      if (shouldRerender) {
        this._log("cells are different, calling _renderCell");
        this._renderCell();
      } else {
        this._log("cells are equal, skipping _renderCell");
      }
    }
  }

  private async _loadAndRenderRecipe(recipeId: string, retry: boolean = true) {
    this._log("loading recipe:", recipeId);

    try {
      // Load and run the recipe
      const recipe = await this.cell.runtime.recipeManager.loadRecipe(
        recipeId,
        this.cell.space,
      );
      await this.cell.runtime.runSynced(this.cell, recipe);

      // Render the UI output
      if (!this._renderContainer) {
        throw new Error("Render container not found");
      }

      this._log("rendering UI");
      this._cleanup = render(this._renderContainer, this.cell.key(UI));
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

      // Validate cell and get recipe ID
      if (!isCell(this.cell)) {
        throw new Error("Invalid cell: expected a Cell object");
      }

      const recipeId = getRecipeIdFromCharm(this.cell);
      if (!recipeId) {
        throw new Error("No recipe ID found in charm");
      }

      // Load and render the recipe
      await this._loadAndRenderRecipe(recipeId);

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

    // Clear the container
    if (this._renderContainer) {
      this._renderContainer.innerHTML = "";
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
