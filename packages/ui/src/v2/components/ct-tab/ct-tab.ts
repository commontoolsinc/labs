import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTTab - Individual tab button component used within ct-tab-list
 *
 * @element ct-tab
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
 * <ct-tab value="profile" selected>Profile</ct-tab>
 */
export class CTTab extends BaseElement {
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
        border-radius: 0.5rem;
        padding: 0.375rem 0.875rem;
        font-size: 0.875rem;
        font-weight: 700;
        line-height: 1.5;
        transition: all 150ms cubic-bezier(0.25, 0.1, 0.25, 1);
        cursor: pointer;
        background: transparent;
        border: none;
        color: var(--ct-theme-color-text-muted, #7a7d72);
        font-family: var(--ct-theme-font-family, inherit);
        position: relative;
        -webkit-font-smoothing: antialiased;
      }

      .tab:hover:not(:disabled) {
        color: var(--ct-theme-color-text, #2c3227);
        background-color: var(--ct-theme-color-surface-hover, #e8e6dd);
      }

      .tab:active:not(:disabled) {
        transform: scale(0.97);
        transition-duration: 0.1s;
      }

      .tab:focus-visible {
        box-shadow:
          0 0 0 2px var(--ct-theme-color-background, #fdfcf9),
          0 0 0 4px var(--ct-theme-color-primary, #2d8c3c);
        outline: none;
      }

      .tab:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .tab[data-selected="true"] {
        color: var(--ct-theme-color-text, #2c3227);
        background-color: var(--ct-theme-color-background, #fdfcf9);
        box-shadow:
          0 1px 3px rgba(60, 70, 50, 0.1),
          0 1px 2px rgba(60, 70, 50, 0.06);
        }

        .tab[data-selected="true"]:hover {
          background-color: var(--ct-theme-color-background, #fdfcf9);
        }

        /* Vertical orientation styles */
        :host-context(ct-tab-list[orientation="vertical"]) .tab {
          width: 100%;
          justify-content: flex-start;
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

    override updated(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
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

  globalThis.customElements.define("ct-tab", CTTab);
