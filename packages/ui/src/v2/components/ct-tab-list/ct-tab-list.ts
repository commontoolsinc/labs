import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTTabList - Container component for tab buttons
 *
 * @element ct-tab-list
 *
 * @attr {string} orientation - Layout orientation: "horizontal" | "vertical" (default: "horizontal")
 *
 * @slot - Default slot for ct-tab elements
 *
 * @example
 * <ct-tab-list orientation="horizontal">
 *   <ct-tab value="tab1">Tab 1</ct-tab>
 *   <ct-tab value="tab2">Tab 2</ct-tab>
 * </ct-tab-list>
 */
export class CTTabList extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: flex;
        flex-shrink: 0;
      }

      .tab-list {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--ct-border-radius-md);
        background-color: var(--ct-colors-gray-100);
        padding: var(--ct-spacing-1);
        height: 2.5rem;
        gap: 0.125rem;
      }

      .tab-list[data-orientation="horizontal"] {
        flex-direction: row;
      }

      .tab-list[data-orientation="vertical"] {
        flex-direction: column;
        height: auto;
        align-items: stretch;
      }

      /* Ensure proper spacing for vertical tabs */
      .tab-list[data-orientation="vertical"] ::slotted(ct-tab) {
        width: 100%;
        justify-content: flex-start;
      }

      /* Dark mode support */
      @media (prefers-color-scheme: dark) {
        .tab-list {
          background-color: var(--ct-colors-gray-800);
        }
      }
    `,
  ];

  static override properties = {
    orientation: { type: String },
  };

  declare orientation: "horizontal" | "vertical";

  constructor() {
    super();
    this.orientation = "horizontal";
  }

  override connectedCallback() {
    super.connectedCallback();

    // Set ARIA attributes
    this.setAttribute("role", "tablist");
    this.setAttribute("aria-orientation", this.orientation);
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("orientation")) {
      this.setAttribute("aria-orientation", this.orientation);
    }
  }

  override render() {
    return html`
      <div class="tab-list" part="list" data-orientation="${this.orientation}">
        <slot></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-tab-list", CTTabList);
