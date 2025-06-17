import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTTabPanel - Content panel component associated with a tab
 *
 * @element ct-tab-panel
 *
 * @attr {string} value - Unique identifier matching the associated tab's value
 * @attr {boolean} hidden - Whether the panel is hidden
 *
 * @slot - Default slot for panel content
 *
 * @example
 * <ct-tab-panel value="profile">
 *   <h2>Profile Content</h2>
 *   <p>Your profile information goes here.</p>
 * </ct-tab-panel>
 */
export class CTTabPanel extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        margin-top: var(--ct-spacing-6);
        animation: fadeIn var(--ct-transition-duration-fast) ease-in;
      }

      :host([hidden]) {
        display: none !important;
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      .tab-panel {
        outline: none;
      }

      .tab-panel:focus-visible {
        outline: 2px solid var(--ring, hsl(222.2, 84%, 4.9%));
        outline-offset: 2px;
        border-radius: var(--radius, 0.375rem);
      }

      /* Vertical orientation - adjust spacing */
      :host-context(ct-tabs[orientation="vertical"]) {
        margin-top: 0;
        margin-left: var(--ct-spacing-6);
      }
    `,
  ];

  static override properties = {
    value: { type: String },
    hidden: { type: Boolean, reflect: true },
  };

  declare value: string;
  declare hidden: boolean;

  constructor() {
    super();
    this.value = "";
    this.hidden = true;
  }

  override connectedCallback() {
    super.connectedCallback();

    // Set ARIA attributes
    this.setAttribute("role", "tabpanel");
    this.setAttribute("tabindex", "0");
    this.updateAriaAttributes();

    // Set up aria-labelledby when associated tab is found
    this.updateAriaLabelledBy();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("hidden")) {
      this.updateAriaAttributes();
    }

    if (changedProperties.has("value")) {
      this.updateAriaLabelledBy();
    }
  }

  override render() {
    return html`
      <div class="tab-panel" part="panel">
        <slot></slot>
      </div>
    `;
  }

  private updateAriaAttributes(): void {
    this.setAttribute("aria-hidden", String(this.hidden));
  }

  private updateAriaLabelledBy(): void {
    if (!this.value) return;

    // Find the associated tab with the same value
    const parentTabs = this.closest("ct-tabs");
    if (parentTabs) {
      const associatedTab = parentTabs.querySelector(
        `ct-tab[value="${this.value}"]`,
      );
      if (associatedTab && !associatedTab.id) {
        // Generate an ID if the tab doesn't have one
        associatedTab.id = `tab-${this.value}`;
      }
      if (associatedTab?.id) {
        this.setAttribute("aria-labelledby", associatedTab.id);
      }
    }
  }

  /**
   * Show the panel
   */
  show(): void {
    this.hidden = false;
  }

  /**
   * Hide the panel
   */
  hide(): void {
    this.hidden = true;
  }

  /**
   * Toggle the panel visibility
   */
  toggle(): void {
    this.hidden = !this.hidden;
  }
}

globalThis.customElements.define("ct-tab-panel", CTTabPanel);
