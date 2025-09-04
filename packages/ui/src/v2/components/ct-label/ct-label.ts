import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTLabel - Form field label with accessibility features
 *
 * @element ct-label
 *
 * @attr {string} for - ID of associated input element
 * @attr {boolean} required - Shows asterisk for required fields
 * @attr {boolean} disabled - Whether the label is disabled
 *
 * @slot - Default slot for label text
 *
 * @fires ct-label-click - Fired on click with detail: { targetId, targetElement }
 *
 * @example
 * <ct-label for="email" required>Email Address</ct-label>
 * <ct-input id="email" type="email"></ct-input>
 */

export class CTLabel extends BaseElement {
  static override styles = css`
    :host {
      display: inline-block;
      box-sizing: border-box;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    .label {
      display: inline-flex;
      align-items: baseline;
      gap: 0.25rem;
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1.25rem;
      color: var(--foreground, hsl(0, 0%, 9%));
      cursor: pointer;
      user-select: none;
    }

    .label.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .required-indicator {
      color: var(--destructive, hsl(0, 100%, 50%));
      font-weight: 600;
      line-height: 1;
      margin-left: 0.125rem;
    }

    /* When used with peer elements */
    :host(:has(+ :disabled)),
    :host(:has(+ [disabled])) .label {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  static override properties = {
    for: { type: String },
    required: { type: Boolean },
    disabled: { type: Boolean },
  };

  declare for: string | null;
  declare required: boolean;
  declare disabled: boolean;

  constructor() {
    super();
    this.for = null;
    this.required = false;
    this.disabled = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("click", this._handleClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("click", this._handleClick);
  }

  override render() {
    return html`
      <label
        class="label ${this.disabled ? "disabled" : ""}"
        part="label"
      >
        <slot></slot>
        ${this.required
          ? html`
            <span class="required-indicator" part="required">*</span>
          `
          : null}
      </label>
    `;
  }

  private _handleClick = (_event: Event): void => {
    // If label has a 'for' attribute, find and focus the associated element
    if (this.for && !this.disabled) {
      // Look for the element in the parent document
      const root = this.getRootNode() as Document | ShadowRoot;
      const targetElement = root.querySelector(
        `#${CSS.escape(this.for)}`,
      ) as HTMLElement;

      if (targetElement) {
        // Focus the element if it's focusable
        if (
          "focus" in targetElement && typeof targetElement.focus === "function"
        ) {
          targetElement.focus();

          // For custom elements, also try clicking them
          if (targetElement.tagName.includes("-")) {
            targetElement.click();
          }
        }

        // Emit custom event
        this.emit("ct-label-click", {
          targetId: this.for,
          targetElement: targetElement,
        });
      }
    }
  };

  /**
   * Get the associated control element
   */
  getControl(): HTMLElement | null {
    if (!this.for) return null;

    const root = this.getRootNode() as Document | ShadowRoot;
    return root.querySelector(`#${CSS.escape(this.for)}`) as HTMLElement;
  }

  /**
   * Focus the associated control element
   */
  focusControl(): void {
    const control = this.getControl();
    if (control && "focus" in control && typeof control.focus === "function") {
      control.focus();
    }
  }
}

globalThis.customElements.define("ct-label", CTLabel);
