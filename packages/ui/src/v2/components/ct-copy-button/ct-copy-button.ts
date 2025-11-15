import { html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTCopyButton - Copy to clipboard button with automatic visual feedback
 *
 * @element ct-copy-button
 *
 * @attr {string} text - Text to copy to clipboard (required)
 * @attr {string} variant - Button style variant (default: "secondary")
 *   Options: "primary" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "pill"
 * @attr {string} size - Button size (default: "default")
 *   Options: "default" | "sm" | "lg" | "icon" | "md"
 * @attr {boolean} disabled - Disable the button
 * @attr {number} feedback-duration - Success feedback duration in ms (default: 2000)
 * @attr {boolean} icon-only - Only show icon, no text (default: false)
 *
 * @fires ct-copy-success - Fired when copy succeeds
 *   Detail: { text: string, length: number }
 * @fires ct-copy-error - Fired when copy fails
 *   Detail: { error: Error, text: string }
 *
 * @slot - Button label text (optional, defaults based on state)
 *
 * @example
 * // Basic usage
 * <ct-copy-button text="Hello World">Copy</ct-copy-button>
 *
 * // Icon only
 * <ct-copy-button text="Hello" icon-only></ct-copy-button>
 *
 * // Custom styling
 * <ct-copy-button
 *   text="data"
 *   variant="ghost"
 *   size="sm"
 * >📋 Copy List</ct-copy-button>
 *
 * // With event handler (in pattern)
 * <ct-copy-button
 *   text={ingredientListText}
 *   onct-copy-success={handleCopySuccess({})}
 * >Copy</ct-copy-button>
 *
 * @todo Future enhancement: Add optional Cell/Stream binding for copy state
 *   so patterns can reactively track when copy happens without using events.
 *   This would enable patterns to derive UI from copy state.
 */
export class CTCopyButton extends BaseElement {
  static override properties = {
    text: { type: String },
    variant: { type: String },
    size: { type: String },
    disabled: { type: Boolean, reflect: true },
    feedbackDuration: { type: Number, attribute: "feedback-duration" },
    iconOnly: { type: Boolean, attribute: "icon-only", reflect: true },
  };

  declare text: string;
  declare variant?: "primary" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "pill";
  declare size?: "default" | "sm" | "lg" | "icon" | "md";
  declare disabled: boolean;
  declare feedbackDuration: number;
  declare iconOnly: boolean;

  private _copied = false;
  private _resetTimeout?: number;

  constructor() {
    super();
    this.text = "";
    this.variant = "secondary";
    this.size = "default";
    this.disabled = false;
    this.feedbackDuration = 2000;
    this.iconOnly = false;
  }

  private async _handleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    if (this.disabled || !this.text) return;

    try {
      await navigator.clipboard.writeText(this.text);

      this._copied = true;
      this.requestUpdate();

      this.emit("ct-copy-success", {
        text: this.text,
        length: this.text.length,
      });

      // Reset copied state after duration
      if (this._resetTimeout) {
        clearTimeout(this._resetTimeout);
      }
      this._resetTimeout = setTimeout(() => {
        this._copied = false;
        this.requestUpdate();
      }, this.feedbackDuration);
    } catch (error) {
      this.emit("ct-copy-error", {
        error: error as Error,
        text: this.text,
      });
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._resetTimeout) {
      clearTimeout(this._resetTimeout);
    }
  }

  override render() {
    const title = this._copied ? "Copied!" : "Copy to clipboard";
    const ariaLabel = this._copied ? "Copied to clipboard" : "Copy to clipboard";

    return html`
      <ct-button
        variant=${this.variant || "secondary"}
        size=${this.size || "default"}
        ?disabled=${this.disabled}
        @click=${this._handleClick}
        title=${title}
        aria-label=${ariaLabel}
      >
        ${this.iconOnly
          ? html`${this._copied ? "✓" : "📋"}`
          : html`
              <slot>
                ${this._copied ? "✓ Copied!" : "📋 Copy"}
              </slot>
            `}
      </ct-button>
    `;
  }
}

globalThis.customElements.define("ct-copy-button", CTCopyButton);
