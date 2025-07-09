import { html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { render } from "@commontools/html";
import { UI } from "@commontools/runner";
import type { Cell } from "@commontools/runner";

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

  protected override render() {
    return html`<div class="render-container"></div>`;
  }

  protected override firstUpdated() {
    this._renderContainer = this.shadowRoot?.querySelector(".render-container") as HTMLDivElement;
    this._renderCell();
  }

  protected override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("cell")) {
      this._renderCell();
    }
  }

  private _renderCell() {
    if (!this._renderContainer) return;

    // Clean up any previous render
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = undefined;
    }

    // Clear the container
    this._renderContainer.innerHTML = "";

    if (!this.cell) return;

    try {
      let content;

      // Check if it's a Cell
      if (this.cell && typeof this.cell.get === "function") {
        const value = this.cell.get();
        content = value?.[UI];
      } else if (this.cell?.[UI]) {
        // Direct object with UI property
        content = this.cell[UI];
      }

      if (content) {
        // Use the html render function which returns a cleanup function
        this._cleanup = render(this._renderContainer, content);
      } else {
        // Fallback for non-renderable content
        this._renderContainer.textContent = this._formatFallback(this.cell);
      }
    } catch (error) {
      // Error boundary
      console.error("Error rendering cell:", error);
      this._renderContainer.innerHTML = `<div style="color: var(--ct-color-destructive)">Error rendering content</div>`;
    }
  }

  private _formatFallback(value: any): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (value && typeof value.get === "function") {
      const cellValue = value.get();
      if (typeof cellValue === "string" || typeof cellValue === "number") {
        return String(cellValue);
      }
    }
    return "";
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = undefined;
    }
  }
}

globalThis.customElements.define("ct-render", CTRender);

declare global {
  interface HTMLElementTagNameMap {
    "ct-render": CTRender;
  }
}