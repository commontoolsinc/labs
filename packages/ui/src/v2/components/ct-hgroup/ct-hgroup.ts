import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTHGroup - Horizontal group component with automatic gap management
 *
 * @element ct-hgroup
 *
 * @attr {string} gap - Gap between items (sm, md, lg) - defaults to md
 * @attr {boolean} wrap - Allow items to wrap
 * @attr {string} align - Align items (start, center, end, stretch, baseline)
 * @attr {string} justify - Justify content (start, center, end, between, around, evenly)
 *
 * @slot - Content to be grouped horizontally
 *
 * @example
 * <ct-hgroup gap="md">
 *   <ct-button>Save</ct-button>
 *   <ct-button variant="outline">Cancel</ct-button>
 * </ct-hgroup>
 */
export class CTHGroup extends BaseElement {
  static override styles = css`
    :host {
      display: inline-flex;
      container-type: inline-size;
    }

    .group {
      display: flex;
      flex-direction: row;
      box-sizing: border-box;
    }

    /* Gap sizes */
    .gap-sm {
      gap: 0.5rem;
    }
    .gap-md {
      gap: 1rem;
    }
    .gap-lg {
      gap: 1.5rem;
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
      align-content: flex-start;
    }

    /* Direct children - preserve sizing */
    ::slotted(*) {
      flex-shrink: 0;
    }
  `;

  static override properties = {
    gap: { type: String },
    wrap: { type: Boolean, reflect: true },
    align: { type: String },
    justify: { type: String },
  };

  declare gap: "sm" | "md" | "lg";
  declare wrap: boolean;
  declare align: string;
  declare justify: string;

  constructor() {
    super();
    this.gap = "md";
    this.wrap = false;
    this.align = "center";
    this.justify = "start";
  }

  override render() {
    const classes = {
      group: true,
      [`gap-${this.gap}`]: true,
      [`align-${this.align}`]: true,
      [`justify-${this.justify}`]: true,
      wrap: this.wrap,
    };

    return html`
      <div class="${classMap(classes)}" part="group">
        <slot></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-hgroup", CTHGroup);
