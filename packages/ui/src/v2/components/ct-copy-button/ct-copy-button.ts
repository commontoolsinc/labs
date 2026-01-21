import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTCopyButton - Copy to clipboard button with automatic visual feedback
 *
 * @element ct-copy-button
 *
 * @attr {string | Record<string, string>} text - Content to copy to clipboard (required)
 *   - String: Copied as text/plain (backwards compatible)
 *   - Object: Keys are MIME types, values are content for each type.
 *     Common types: "text/plain", "text/html"
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
 * // Rich text with HTML (pastes as formatted text in rich editors)
 * <ct-copy-button
 *   text={{
 *     "text/plain": "Hello World",
 *     "text/html": "<b>Hello World</b>"
 *   }}
 * >Copy</ct-copy-button>
 *
 * // With event handler (in pattern)
 * <ct-copy-button
 *   text={ingredientListText}
 *   onct-copy-success={handleCopySuccess({})}
 * >Copy</ct-copy-button>
 */
export class CTCopyButton extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      /* Ensure icon-only buttons maintain square aspect ratio */
      :host([icon-only]) ct-button {
        min-width: 2.25rem;
        display: inline-flex;
      }

      /* Adjust for different sizes when icon-only */
      :host([icon-only]) ct-button::part(button) {
        aspect-ratio: 1;
        min-width: fit-content;
      }
    `,
  ];

  static override properties = {
    text: {}, // Can be string or object, no automatic conversion
    variant: { type: String },
    size: { type: String },
    disabled: { type: Boolean, reflect: true },
    feedbackDuration: { type: Number, attribute: "feedback-duration" },
    iconOnly: { type: Boolean, attribute: "icon-only", reflect: true },
  };

  declare text: string | Record<string, string>;
  declare variant?:
    | "primary"
    | "secondary"
    | "destructive"
    | "outline"
    | "ghost"
    | "link"
    | "pill";
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
      // Determine the plain text content for events
      const plainText = typeof this.text === "string"
        ? this.text
        : this.text["text/plain"] || Object.values(this.text)[0] || "";

      if (typeof this.text === "string") {
        // Simple case: plain text (backwards compatible)
        await navigator.clipboard.writeText(this.text);
      } else {
        // Rich content: create ClipboardItem with multiple MIME types
        const clipboardData: Record<string, Blob> = {};
        for (const [mimeType, content] of Object.entries(this.text)) {
          clipboardData[mimeType] = new Blob([content], { type: mimeType });
        }
        await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
      }

      this._copied = true;
      this.requestUpdate();

      this.emit("ct-copy-success", {
        text: plainText,
        length: plainText.length,
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
      const plainText = typeof this.text === "string"
        ? this.text
        : this.text["text/plain"] || Object.values(this.text)[0] || "";
      this.emit("ct-copy-error", {
        error: error as Error,
        text: plainText,
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
    const ariaLabel = this._copied
      ? "Copied to clipboard"
      : "Copy to clipboard";

    return html`
      <ct-button
        variant="${this.variant || "secondary"}"
        size="${this.size || "default"}"
        ?disabled="${this.disabled}"
        @click="${this._handleClick}"
        title="${title}"
        aria-label="${ariaLabel}"
      >
        ${this.iconOnly
          ? html`
            ${this._copied ? "✓" : "📋"}
          `
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
