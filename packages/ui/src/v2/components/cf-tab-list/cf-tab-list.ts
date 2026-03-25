import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFTabList - Container component for tab buttons
 *
 * @element cf-tab-list
 *
 * @attr {string} orientation - Layout orientation: "horizontal" | "vertical" (default: "horizontal")
 *
 * @slot - Default slot for cf-tab elements
 *
 * @example
 * <cf-tab-list orientation="horizontal">
 *   <cf-tab value="tab1">Tab 1</cf-tab>
 *   <cf-tab value="tab2">Tab 2</cf-tab>
 * </cf-tab-list>
 */
export class CFTabList extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-tab-list-border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md)
        );
        --cf-tab-list-color-surface: var(--cf-theme-color-surface, #f1f5f9);

        display: flex;
        flex-shrink: 0;
      }

      .tab-list {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--cf-tab-list-border-radius, var(--cf-border-radius-md));
        background-color: var(--cf-tab-list-color-surface, #f1f5f9);
        padding: var(--cf-spacing-1);
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
      .tab-list[data-orientation="vertical"] ::slotted(cf-tab) {
        width: 100%;
        justify-content: flex-start;
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

globalThis.customElements.define("cf-tab-list", CFTabList);
