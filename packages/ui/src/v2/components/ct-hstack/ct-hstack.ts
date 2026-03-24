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
      --ct-hstack-gap-0: 0;
      --ct-hstack-gap-1: 0.25rem;
      --ct-hstack-gap-2: 0.5rem;
      --ct-hstack-gap-3: 0.75rem;
      --ct-hstack-gap-4: 1rem;
      --ct-hstack-gap-5: 1.25rem;
      --ct-hstack-gap-6: 1.5rem;
      --ct-hstack-gap-8: 2rem;
      --ct-hstack-gap-10: 2.5rem;
      --ct-hstack-gap-12: 3rem;
      --ct-hstack-gap-16: 4rem;
      --ct-hstack-gap-20: 5rem;
      --ct-hstack-gap-24: 6rem;
      --ct-hstack-padding-0: 0;
      --ct-hstack-padding-1: 0.25rem;
      --ct-hstack-padding-2: 0.5rem;
      --ct-hstack-padding-3: 0.75rem;
      --ct-hstack-padding-4: 1rem;
      --ct-hstack-padding-5: 1.25rem;
      --ct-hstack-padding-6: 1.5rem;
      --ct-hstack-padding-8: 2rem;
      --ct-hstack-padding-10: 2.5rem;
      --ct-hstack-padding-12: 3rem;
      --ct-hstack-padding-16: 4rem;
      --ct-hstack-padding-20: 5rem;
      --ct-hstack-padding-24: 6rem;

      display: block;
      overflow: hidden;
    }

    .stack {
      display: flex;
      flex-direction: row;
      box-sizing: border-box;
      height: 100%;
    }

    /* Gap utilities */
    .gap-0 {
      gap: var(--ct-hstack-gap-0);
    }
    .gap-1 {
      gap: var(--ct-hstack-gap-1);
    }
    .gap-2 {
      gap: var(--ct-hstack-gap-2);
    }
    .gap-3 {
      gap: var(--ct-hstack-gap-3);
    }
    .gap-4 {
      gap: var(--ct-hstack-gap-4);
    }
    .gap-5 {
      gap: var(--ct-hstack-gap-5);
    }
    .gap-6 {
      gap: var(--ct-hstack-gap-6);
    }
    .gap-8 {
      gap: var(--ct-hstack-gap-8);
    }
    .gap-10 {
      gap: var(--ct-hstack-gap-10);
    }
    .gap-12 {
      gap: var(--ct-hstack-gap-12);
    }
    .gap-16 {
      gap: var(--ct-hstack-gap-16);
    }
    .gap-20 {
      gap: var(--ct-hstack-gap-20);
    }
    .gap-24 {
      gap: var(--ct-hstack-gap-24);
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
      padding: var(--ct-hstack-padding-0);
    }
    .p-1 {
      padding: var(--ct-hstack-padding-1);
    }
    .p-2 {
      padding: var(--ct-hstack-padding-2);
    }
    .p-3 {
      padding: var(--ct-hstack-padding-3);
    }
    .p-4 {
      padding: var(--ct-hstack-padding-4);
    }
    .p-5 {
      padding: var(--ct-hstack-padding-5);
    }
    .p-6 {
      padding: var(--ct-hstack-padding-6);
    }
    .p-8 {
      padding: var(--ct-hstack-padding-8);
    }
    .p-10 {
      padding: var(--ct-hstack-padding-10);
    }
    .p-12 {
      padding: var(--ct-hstack-padding-12);
    }
    .p-16 {
      padding: var(--ct-hstack-padding-16);
    }
    .p-20 {
      padding: var(--ct-hstack-padding-20);
    }
    .p-24 {
      padding: var(--ct-hstack-padding-24);
    }

    /* Direct children styling - allow flex children to shrink by default
      so scroll containers like ct-vscroll can be height-constrained */
    ::slotted(*) {
      min-height: 0;
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
