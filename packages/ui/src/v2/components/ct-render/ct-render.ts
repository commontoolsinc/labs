import { css, html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { isVNode, render } from "@commontools/html";
import { isCell, UI } from "@commontools/runner";
import type { Cell } from "@commontools/runner";
import { getRecipeIdFromCharm } from "@commontools/charm";

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

    await this._maybeSyncCell(cell);
    const target = await this._resolveRenderTarget(cell);

    this._log("rendering UI");
    if (isCell(target)) {
      this._cleanup = render(this._renderContainer, target as Cell);
    } else {
      this._cleanup = render(this._renderContainer, target as any);
    }
  }

  private async _resolveRenderTarget(
    cell: Cell<unknown>,
  ): Promise<Cell<unknown> | unknown> {
    const value = this._safeGetCellValue(cell);
    if (this._isRecord(value) && UI in value) {
      const uiCell = (cell as Cell).key(UI);
      await this._maybeSyncCell(uiCell);
      const uiValue = this._safeGetCellValue(uiCell);
      if (uiValue === undefined || this._isRenderableVNode(uiValue)) {
        return uiCell;
      }
    }

    if (this._isRenderableVNode(value) || value === undefined) {
      return cell;
    }

    return cell;
  }

  private async _maybeSyncCell(cell: Cell<unknown>) {
    const sync = (cell as { sync?: () => Promise<unknown> | unknown }).sync;
    if (typeof sync === "function") {
      await sync.call(cell);
    }
  }

  private _getRecipeId(cell: Cell<unknown>): string | undefined {
    try {
      return getRecipeIdFromCharm(cell);
    } catch (error) {
      this._log("no recipe id available", error);
      return undefined;
    }
  }

  private _safeGetCellValue(cell: Cell<unknown>): unknown {
    try {
      return cell.get();
    } catch (error) {
      this._log("failed to read cell value", error);
      return undefined;
    }
  }

  private _isRenderableVNode(value: unknown): boolean {
    return isVNode(value);
  }

  private _isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private _getCellPathLength(cell: Cell<unknown>): number {
    const internalCell = cell as unknown as {
      getAsNormalizedFullLink?: () => { path: readonly string[] };
    };
    const getter = internalCell.getAsNormalizedFullLink;
    if (typeof getter !== "function") {
      return 0;
    }
    const link = getter.call(cell);
    return Array.isArray(link?.path) ? link.path.length : 0;
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

      if (!isCell(this.cell)) {
        throw new Error("Invalid cell: expected a Cell object");
      }

      const isSubPath = this._getCellPathLength(this.cell) > 0;

      if (isSubPath) {
        this._log("cell is a subpath, rendering directly");
        await this._renderUiFromCell(this.cell);
      } else {
        const recipeId = this._getRecipeId(this.cell);
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
