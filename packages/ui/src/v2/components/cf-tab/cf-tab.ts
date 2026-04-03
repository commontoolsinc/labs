import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFTab - Individual tab button component used within cf-tab-list
 *
 * @element cf-tab
 *
 * @attr {string} value - Unique identifier for the tab
 * @attr {boolean} disabled - Whether the tab is disabled
 * @attr {boolean} selected - Whether the tab is currently selected
 *
 * @slot - Default slot for tab label content
 *
 * @fires tab-click - Fired when tab is clicked with detail: { tab }
 *
 * @example
 * <cf-tab value="profile" selected>Profile</cf-tab>
 */
export class CFTab extends BaseElement {
  static override properties = {
    value: { type: String, reflect: true },
    disabled: { type: Boolean },
    selected: { type: Boolean },
  };
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-flex;
      }

      .tab {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        border-radius: var(--cf-theme-border-radius, var(--cf-border-radius-md));
        padding: var(--cf-spacing-2) var(--cf-spacing-3);
        font-size: var(--cf-font-size-sm);
        font-weight: var(--cf-font-weight-medium);
        transition: all var(--cf-transition-duration-fast)
          var(--cf-transition-timing-ease);
        cursor: pointer;
        background: transparent;
        border: none;
        color: var(--cf-theme-color-text-muted, #6b7280);
        font-family: inherit;
        position: relative;
      }

      .tab:hover:not(:disabled) {
        color: var(--cf-theme-color-text, #111827);
      }

      .tab:focus-visible {
        outline: 2px solid
          var(--cf-theme-color-primary, var(--cf-colors-primary-500));
        outline-offset: 2px;
      }

      .tab:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .tab[data-selected="true"] {
        color: var(--cf-theme-color-text, #111827);
      }

      /* Indicator for selected state */
      .tab[data-selected="true"]::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: -1px;
        height: 2px;
        background-color: var(
          --cf-theme-color-primary,
          var(--cf-colors-primary-500)
        );
      }

      /* Vertical orientation styles */
      :host-context(cf-tab-list[orientation="vertical"])
        .tab[data-selected="true"]::after {
        top: 0;
        bottom: 0;
        left: -1px;
        right: auto;
        width: 2px;
        height: auto;
      }
    `,
  ];

  declare value: string;
  declare disabled: boolean;
  declare selected: boolean;

  private _button: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.value = "";
    this.disabled = false;
    this.selected = false;
  }

  get button(): HTMLButtonElement | null {
    if (!this._button) {
      this._button =
        this.shadowRoot?.querySelector(".tab") as HTMLButtonElement || null;
    }
    return this._button;
  }

  override connectedCallback() {
    super.connectedCallback();

    // Set ARIA attributes
    this.setAttribute("role", "tab");
    this.updateAriaAttributes();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (
      changedProperties.has("selected") || changedProperties.has("disabled")
    ) {
      this.updateAriaAttributes();
    }
  }

  override render() {
    return html`
      <button
        class="tab"
        part="tab"
        ?disabled="${this.disabled}"
        data-selected="${this.selected}"
        data-disabled="${this.disabled}"
        @click="${this.handleClick}"
        @keydown="${this.handleKeydown}"
      >
        <slot></slot>
      </button>
    `;
  }

  private updateAriaAttributes(): void {
    this.setAttribute("aria-selected", String(this.selected));
    this.setAttribute("aria-disabled", String(this.disabled));
    this.setAttribute(
      "tabindex",
      this.selected && !this.disabled ? "0" : "-1",
    );
  }

  private handleClick = (event: Event): void => {
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Emit custom event for parent tabs component
    this.emit("tab-click", { tab: this });
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      this.click();
    }
  };

  /**
   * Focus the tab button
   */
  override focus(): void {
    this.button?.focus();
  }

  /**
   * Blur the tab button
   */
  override blur(): void {
    this.button?.blur();
  }
}

globalThis.customElements.define("cf-tab", CFTab);
