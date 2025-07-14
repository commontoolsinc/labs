import { html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { render } from "@commontools/html";
import { isCell, UI } from "@commontools/runner";
import type { Cell } from "@commontools/runner";
import { getRecipeIdFromCharm } from "@commontools/charm";

/**
 * CTRender - Renders a cell or object with a [UI] property as VDOM
 *
 * @element ct-render
 *
 * @attr {Cell | any} cell - The cell or object to render
 *
 * @example
 * <ct-render .cell=${myCharmCell}></ct-render>
 */
export class CTRender extends BaseElement {
  static override properties = {
    cell: { attribute: false },
  };

  declare cell: Cell | any;

  private _renderContainer?: HTMLDivElement;
  private _cleanup?: () => void;
  private _instanceId = Math.random().toString(36).substring(7);
  private _renderInProgress = false;

  protected override render() {
    return html`
      <div class="render-container"></div>
    `;
  }

  protected override firstUpdated() {
    console.log(`[ct-render ${this._instanceId}] firstUpdated called`);
    console.trace(`[ct-render ${this._instanceId}] Component created from:`);
    this._renderContainer = this.shadowRoot?.querySelector(
      ".render-container",
    ) as HTMLDivElement;
    // Skip initial render if cell is already set - updated() will handle it
    if (!this.cell) {
      this._renderCell();
    }
  }

  protected override updated(changedProperties: PropertyValues) {
    console.log(`[ct-render ${this._instanceId}] updated called, changedProperties:`, Array.from(changedProperties.keys()));
    if (changedProperties.has("cell")) {
      console.log(`[ct-render ${this._instanceId}] cell changed, calling _renderCell`);
      this._renderCell();
    }
  }

  private async _startRecipe(recipeId: string) {
    console.log(`[ct-render ${this._instanceId}] _startRecipe called with recipeId:`, recipeId);
    const recipe = await this.cell.runtime.recipeManager.loadRecipe(
      recipeId,
    );
    console.log(`[ct-render ${this._instanceId}] recipe loaded, running synced`);
    await this.cell.runtime.runSynced(this.cell, recipe);
    await this.cell.runtime.idle();

    if (!this._renderContainer) {
      throw new Error("Render container not found");
    }
    console.log(`[ct-render ${this._instanceId}] calling render() for UI`);
    this._cleanup = render(this._renderContainer, this.cell.key(UI));
    console.log(`[ct-render ${this._instanceId}] render complete, cleanup function stored`);
  }

  private async _renderCell() {
    console.log(`[ct-render ${this._instanceId}] _renderCell called`);
    
    // Prevent concurrent renders
    if (this._renderInProgress) {
      console.log(`[ct-render ${this._instanceId}] render already in progress, skipping`);
      return;
    }
    
    if (!this._renderContainer) {
      console.log(`[ct-render ${this._instanceId}] no render container, returning`);
      return;
    }

    // Clean up any previous render
    if (this._cleanup) {
      console.log(`[ct-render ${this._instanceId}] cleaning up previous render`);
      this._cleanup();
      this._cleanup = undefined;
    }

    // Clear the container
    console.log(`[ct-render ${this._instanceId}] clearing container innerHTML`);
    this._renderContainer.innerHTML = "";

    if (!this.cell) {
      console.log(`[ct-render ${this._instanceId}] no cell, returning`);
      return;
    }

    try {
      this._renderInProgress = true;
      let content;

      // Check if it's a Cell
      if (isCell(this.cell)) {
        const recipeId = getRecipeIdFromCharm(this.cell);
        console.log(`[ct-render ${this._instanceId}] recipeId from charm:`, recipeId);
        if (recipeId) {
          await this._startRecipe(recipeId);
        }
      } else {
        throw new Error("Invalid cell");
      }
    } catch (error) {
      // Error boundary
      console.error(`[ct-render ${this._instanceId}] Error rendering cell:`, error);
      this._renderContainer.innerHTML =
        `<div style="color: var(--ct-color-destructive)">Error rendering content</div>`;
    } finally {
      this._renderInProgress = false;
    }
  }

  override disconnectedCallback() {
    console.log(`[ct-render ${this._instanceId}] disconnectedCallback called`);
    super.disconnectedCallback();
    
    // Cancel any in-progress renders
    this._renderInProgress = false;
    
    // Clean up any existing render
    if (this._cleanup) {
      console.log(`[ct-render ${this._instanceId}] cleaning up in disconnectedCallback`);
      this._cleanup();
      this._cleanup = undefined;
    }
    
    // Clear the container
    if (this._renderContainer) {
      this._renderContainer.innerHTML = "";
    }
  }
}

globalThis.customElements.define("ct-render", CTRender);

declare global {
  interface HTMLElementTagNameMap {
    "ct-render": CTRender;
  }
}
