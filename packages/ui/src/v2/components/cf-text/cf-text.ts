import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

export type TextVariant =
  | "caption"
  | "body-compact"
  | "body"
  | "body-large"
  | "heading-sm"
  | "heading-md"
  | "heading-lg";

export type TextTone =
  | "default"
  | "muted"
  | "tertiary"
  | "disabled"
  | "primary"
  | "success"
  | "warning"
  | "error";

/**
 * CFText - Generic text primitive for non-label typography.
 *
 * Use cf-label when text labels a specific control. Use cf-text for captions,
 * helper copy, metadata, descriptions, and other display text.
 *
 * @element cf-text
 *
 * @attr {string} variant - Typography role. Defaults to "body".
 * @attr {string} tone - Semantic color tone. Defaults to "default".
 * @attr {boolean} block - Render as block text instead of inline text.
 *
 * @slot - Text content
 */
export class CFText extends BaseElement {
  static override properties = {
    variant: { type: String, reflect: true },
    tone: { type: String, reflect: true },
    block: { type: Boolean, reflect: true },
  };

  declare variant: TextVariant;
  declare tone: TextTone;
  declare block: boolean;

  constructor() {
    super();
    this.variant = "body";
    this.tone = "default";
    this.block = false;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-text-font-size: var(--cf-font-body-size, 0.875rem);
        --cf-text-line-height: var(--cf-font-body-line-height, 1.25rem);
        --cf-text-font-weight: var(--cf-font-body-weight, 400);
        --cf-text-letter-spacing: var(--cf-font-body-letter-spacing, 0);
        --cf-text-color: var(--cf-theme-color-text, #16181d);

        display: inline;
        color: var(--cf-text-color);
        font-family: var(--cf-theme-font-family, inherit);
        font-size: var(--cf-text-font-size);
        font-weight: var(--cf-text-font-weight);
        line-height: var(--cf-text-line-height);
        letter-spacing: var(--cf-text-letter-spacing);
      }

      :host([block]) {
        display: block;
      }

      :host([variant="caption"]) {
        --cf-text-font-size: var(--cf-font-caption-size, 0.75rem);
        --cf-text-line-height: var(--cf-font-caption-line-height, 1rem);
        --cf-text-font-weight: var(--cf-font-caption-weight, 500);
        --cf-text-letter-spacing: var(--cf-font-caption-letter-spacing, 0);
      }

      :host([variant="body-compact"]) {
        --cf-text-font-size: var(--cf-font-body-compact-size, 0.8125rem);
        --cf-text-line-height: var(--cf-font-body-compact-line-height, 1.25rem);
        --cf-text-font-weight: var(--cf-font-body-compact-weight, 500);
        --cf-text-letter-spacing: var(
          --cf-font-body-compact-letter-spacing,
          0
        );
      }

      :host([variant="body-large"]) {
        --cf-text-font-size: var(--cf-font-body-large-size, 1rem);
        --cf-text-line-height: var(--cf-font-body-large-line-height, 1.5rem);
        --cf-text-font-weight: var(--cf-font-body-large-weight, 400);
        --cf-text-letter-spacing: var(--cf-font-body-large-letter-spacing, 0);
      }

      :host([variant="heading-sm"]) {
        --cf-text-font-size: var(--cf-font-heading-sm-size, 1.125rem);
        --cf-text-line-height: var(--cf-font-heading-sm-line-height, 1.5rem);
        --cf-text-font-weight: var(--cf-font-heading-sm-weight, 600);
        --cf-text-letter-spacing: var(--cf-font-heading-sm-letter-spacing, 0);
      }

      :host([variant="heading-md"]) {
        --cf-text-font-size: var(--cf-font-heading-md-size, 1.25rem);
        --cf-text-line-height: var(--cf-font-heading-md-line-height, 1.75rem);
        --cf-text-font-weight: var(--cf-font-heading-md-weight, 600);
        --cf-text-letter-spacing: var(--cf-font-heading-md-letter-spacing, 0);
      }

      :host([variant="heading-lg"]) {
        --cf-text-font-size: var(--cf-font-heading-lg-size, 1.5rem);
        --cf-text-line-height: var(--cf-font-heading-lg-line-height, 2rem);
        --cf-text-font-weight: var(--cf-font-heading-lg-weight, 600);
        --cf-text-letter-spacing: var(--cf-font-heading-lg-letter-spacing, 0);
      }

      :host([tone="muted"]) {
        --cf-text-color: var(--cf-theme-color-text-muted, #5b5f65);
      }

      :host([tone="tertiary"]) {
        --cf-text-color: var(--cf-theme-color-text-tertiary, #94979e);
      }

      :host([tone="disabled"]) {
        --cf-text-color: var(--cf-theme-color-text-disabled, #b3b6bc);
      }

      :host([tone="primary"]) {
        --cf-text-color: var(--cf-theme-color-primary, #4979fa);
      }

      :host([tone="success"]) {
        --cf-text-color: var(--cf-theme-color-success, #21c17b);
      }

      :host([tone="warning"]) {
        --cf-text-color: var(--cf-theme-color-warning, #e5a126);
      }

      :host([tone="error"]) {
        --cf-text-color: var(--cf-theme-color-error, #ff6057);
      }
    `,
  ];

  override render() {
    return html`
      <slot></slot>
    `;
  }
}

globalThis.customElements.define("cf-text", CFText);
