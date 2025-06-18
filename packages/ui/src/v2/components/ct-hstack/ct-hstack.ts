import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTHStack - Horizontal stack layout component using flexbox
 *
 * @element ct-hstack
 *
 * @attr {string} gap - Gap between items (0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24)
 * @attr {string} align - Align items (start, center, end, stretch, baseline)
 * @attr {string} justify - Justify content (start, center, end, between, around, evenly)
 * @attr {boolean} wrap - Allow items to wrap
 * @attr {boolean} reverse - Reverse the direction
 * @attr {string} padding - Padding around the stack (0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24)
 *
 * @slot - Content to be stacked horizontally
 *
 * @example
 * <ct-hstack gap="4" align="center">
 *   <div>Item 1</div>
 *   <div>Item 2</div>
 * </ct-hstack>
 */
export class CTHStack extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      container-type: inline-size;
    }

    .stack {
      display: flex;
      flex-direction: row;
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

    /* Alignment */
    .align-start {
      align-items: flex-start;
    }
    .align-center {
      align-items: center;
    }
    .align-end {
      align-items: flex-end;
    }
    .align-stretch {
      align-items: stretch;
    }
    .align-baseline {
      align-items: baseline;
    }

    /* Justification */
    .justify-start {
      justify-content: flex-start;
    }
    .justify-center {
      justify-content: center;
    }
    .justify-end {
      justify-content: flex-end;
    }
    .justify-between {
      justify-content: space-between;
    }
    .justify-around {
      justify-content: space-around;
    }
    .justify-evenly {
      justify-content: space-evenly;
    }

    /* Wrap */
    .wrap {
      flex-wrap: wrap;
    }

    /* Reverse */
    .reverse {
      flex-direction: row-reverse;
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

    /* Direct children styling */
    ::slotted(*) {
      flex-shrink: 0;
    }
  `;

  static override properties = {
    gap: { type: String },
    align: { type: String },
    justify: { type: String },
    wrap: { type: Boolean },
    reverse: { type: Boolean },
    padding: { type: String },
  };

  declare gap: string;
  declare align: string;
  declare justify: string;
  declare wrap: boolean;
  declare reverse: boolean;
  declare padding: string;

  constructor() {
    super();
    this.gap = "0";
    this.align = "stretch";
    this.justify = "start";
    this.wrap = false;
    this.reverse = false;
    this.padding = "0";
  }

  override render() {
    const classes = {
      stack: true,
      [`gap-${this.gap}`]: true,
      [`align-${this.align}`]: true,
      [`justify-${this.justify}`]: true,
      [`p-${this.padding}`]: true,
      wrap: this.wrap,
      reverse: this.reverse,
    };

    return html`
      <div class="${classMap(classes)}" part="stack">
        <slot></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-hstack", CTHStack);
