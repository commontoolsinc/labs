import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTGrid - CSS Grid layout component
 *
 * @element ct-grid
 *
 * @attr {string} columns - Number of columns (1-12) or custom template
 * @attr {string} rows - Number of rows or custom template
 * @attr {string} gap - Gap between items (0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24)
 * @attr {string} row-gap - Row gap (overrides gap)
 * @attr {string} column-gap - Column gap (overrides gap)
 * @attr {string} align - Align items (start, center, end, stretch)
 * @attr {string} justify - Justify items (start, center, end, stretch)
 * @attr {string} place - Place items shorthand (combines align and justify)
 * @attr {string} flow - Grid auto flow (row, column, dense, row-dense, column-dense)
 * @attr {string} padding - Padding around the grid
 *
 * @slot - Content to be laid out in a grid
 *
 * @example
 * <ct-grid columns="3" gap="4">
 *   <div>Item 1</div>
 *   <div>Item 2</div>
 *   <div>Item 3</div>
 * </ct-grid>
 */
export class CTGrid extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      container-type: inline-size;
    }

    .grid {
      display: grid;
      box-sizing: border-box;
    }

    /* Gap utilities */
    .gap-0 {
      gap: 0;
    }
    .gap-1 {
      gap: 0.25rem;
    }
    .gap-2 {
      gap: 0.5rem;
    }
    .gap-3 {
      gap: 0.75rem;
    }
    .gap-4 {
      gap: 1rem;
    }
    .gap-5 {
      gap: 1.25rem;
    }
    .gap-6 {
      gap: 1.5rem;
    }
    .gap-8 {
      gap: 2rem;
    }
    .gap-10 {
      gap: 2.5rem;
    }
    .gap-12 {
      gap: 3rem;
    }
    .gap-16 {
      gap: 4rem;
    }
    .gap-20 {
      gap: 5rem;
    }
    .gap-24 {
      gap: 6rem;
    }

    /* Row gap utilities */
    .row-gap-0 {
      row-gap: 0;
    }
    .row-gap-1 {
      row-gap: 0.25rem;
    }
    .row-gap-2 {
      row-gap: 0.5rem;
    }
    .row-gap-3 {
      row-gap: 0.75rem;
    }
    .row-gap-4 {
      row-gap: 1rem;
    }
    .row-gap-5 {
      row-gap: 1.25rem;
    }
    .row-gap-6 {
      row-gap: 1.5rem;
    }
    .row-gap-8 {
      row-gap: 2rem;
    }
    .row-gap-10 {
      row-gap: 2.5rem;
    }
    .row-gap-12 {
      row-gap: 3rem;
    }
    .row-gap-16 {
      row-gap: 4rem;
    }

    /* Column gap utilities */
    .col-gap-0 {
      column-gap: 0;
    }
    .col-gap-1 {
      column-gap: 0.25rem;
    }
    .col-gap-2 {
      column-gap: 0.5rem;
    }
    .col-gap-3 {
      column-gap: 0.75rem;
    }
    .col-gap-4 {
      column-gap: 1rem;
    }
    .col-gap-5 {
      column-gap: 1.25rem;
    }
    .col-gap-6 {
      column-gap: 1.5rem;
    }
    .col-gap-8 {
      column-gap: 2rem;
    }
    .col-gap-10 {
      column-gap: 2.5rem;
    }
    .col-gap-12 {
      column-gap: 3rem;
    }
    .col-gap-16 {
      column-gap: 4rem;
    }

    /* Alignment */
    .align-start {
      align-items: start;
    }
    .align-center {
      align-items: center;
    }
    .align-end {
      align-items: end;
    }
    .align-stretch {
      align-items: stretch;
    }

    /* Justification */
    .justify-start {
      justify-items: start;
    }
    .justify-center {
      justify-items: center;
    }
    .justify-end {
      justify-items: end;
    }
    .justify-stretch {
      justify-items: stretch;
    }

    /* Place items */
    .place-start {
      place-items: start;
    }
    .place-center {
      place-items: center;
    }
    .place-end {
      place-items: end;
    }
    .place-stretch {
      place-items: stretch;
    }

    /* Grid flow */
    .flow-row {
      grid-auto-flow: row;
    }
    .flow-column {
      grid-auto-flow: column;
    }
    .flow-dense {
      grid-auto-flow: dense;
    }
    .flow-row-dense {
      grid-auto-flow: row dense;
    }
    .flow-column-dense {
      grid-auto-flow: column dense;
    }

    /* Padding utilities */
    .p-0 {
      padding: 0;
    }
    .p-1 {
      padding: 0.25rem;
    }
    .p-2 {
      padding: 0.5rem;
    }
    .p-3 {
      padding: 0.75rem;
    }
    .p-4 {
      padding: 1rem;
    }
    .p-5 {
      padding: 1.25rem;
    }
    .p-6 {
      padding: 1.5rem;
    }
    .p-8 {
      padding: 2rem;
    }
    .p-10 {
      padding: 2.5rem;
    }
    .p-12 {
      padding: 3rem;
    }
    .p-16 {
      padding: 4rem;
    }
    .p-20 {
      padding: 5rem;
    }
    .p-24 {
      padding: 6rem;
    }

    /* Responsive grid columns */
    @container (min-width: 640px) {
      .grid-sm-1 {
        grid-template-columns: repeat(1, minmax(0, 1fr));
      }
      .grid-sm-2 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .grid-sm-3 {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .grid-sm-4 {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .grid-sm-6 {
        grid-template-columns: repeat(6, minmax(0, 1fr));
      }
    }

    @container (min-width: 768px) {
      .grid-md-1 {
        grid-template-columns: repeat(1, minmax(0, 1fr));
      }
      .grid-md-2 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .grid-md-3 {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .grid-md-4 {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .grid-md-6 {
        grid-template-columns: repeat(6, minmax(0, 1fr));
      }
    }

    @container (min-width: 1024px) {
      .grid-lg-1 {
        grid-template-columns: repeat(1, minmax(0, 1fr));
      }
      .grid-lg-2 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .grid-lg-3 {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .grid-lg-4 {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .grid-lg-6 {
        grid-template-columns: repeat(6, minmax(0, 1fr));
      }
    }
  `;

  static override properties = {
    columns: { type: String },
    rows: { type: String },
    gap: { type: String },
    rowGap: { type: String, attribute: "row-gap" },
    columnGap: { type: String, attribute: "column-gap" },
    align: { type: String },
    justify: { type: String },
    place: { type: String },
    flow: { type: String },
    padding: { type: String },
  };

  declare columns: string;
  declare rows: string;
  declare gap: string;
  declare rowGap: string;
  declare columnGap: string;
  declare align: string;
  declare justify: string;
  declare place: string;
  declare flow: string;
  declare padding: string;

  constructor() {
    super();
    this.columns = "1";
    this.rows = "";
    this.gap = "0";
    this.rowGap = "";
    this.columnGap = "";
    this.align = "stretch";
    this.justify = "stretch";
    this.place = "";
    this.flow = "row";
    this.padding = "0";
  }

  private getGridTemplateColumns(): string {
    // Check if it's a number (1-12)
    const num = parseInt(this.columns);
    if (!isNaN(num) && num >= 1 && num <= 12) {
      return `repeat(${num}, minmax(0, 1fr))`;
    }
    // Otherwise, use as custom template
    return this.columns;
  }

  private getGridTemplateRows(): string {
    if (!this.rows) return "";

    // Check if it's a number
    const num = parseInt(this.rows);
    if (!isNaN(num) && num >= 1) {
      return `repeat(${num}, minmax(0, 1fr))`;
    }
    // Otherwise, use as custom template
    return this.rows;
  }

  override render() {
    const classes: Record<string, boolean> = {
      grid: true,
      [`p-${this.padding}`]: true,
      [`flow-${this.flow}`]: true,
    };

    // Add place or align/justify classes
    if (this.place) {
      classes[`place-${this.place}`] = true;
    } else {
      if (this.align) classes[`align-${this.align}`] = true;
      if (this.justify) classes[`justify-${this.justify}`] = true;
    }

    // Add gap classes
    if (this.rowGap || this.columnGap) {
      if (this.rowGap) classes[`row-gap-${this.rowGap}`] = true;
      if (this.columnGap) classes[`col-gap-${this.columnGap}`] = true;
    } else {
      classes[`gap-${this.gap}`] = true;
    }

    const gridStyle = {
      "grid-template-columns": this.getGridTemplateColumns(),
      ...(this.rows && { "grid-template-rows": this.getGridTemplateRows() }),
    };

    return html`
      <div
        class="${classMap(classes)}"
        part="grid"
        style="${Object.entries(gridStyle).map(([k, v]) => `${k}: ${v}`).join(
          "; ",
        )}"
      >
        <slot></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-grid", CTGrid);
