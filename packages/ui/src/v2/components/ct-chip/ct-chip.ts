import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTChip - Reusable pill/chip component
 *
 * @element ct-chip
 *
 * @attr {string} label - Chip label text to display
 * @attr {string} variant - Visual variant: "default" | "primary" | "accent" (default: "default")
 * @attr {boolean} removable - Whether to show remove button (default: false)
 * @attr {boolean} interactive - Whether chip is clickable (default: false)
 *
 * @fires ct-remove - Fired when remove button is clicked
 * @fires ct-click - Fired when chip is clicked (if interactive)
 *
 * @slot icon - Optional icon before the label
 * @slot - Main content (overrides label)
 *
 * @example
 * <ct-chip label="Tools" variant="default"></ct-chip>
 * <ct-chip label="Alice" variant="primary" removable></ct-chip>
 */
export class CTChip extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.25rem 0.625rem;
        background: var(
          --ct-theme-color-surface,
          var(--ct-color-gray-100, #f5f5f5)
        );
        color: var(
          --ct-theme-color-text,
          var(--ct-color-gray-900, #212121)
        );
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-300, #e0e0e0));
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-full, 9999px)
        );
        font-size: 0.8125rem;
        line-height: 1;
        user-select: none;
        transition: border-color var(--ct-theme-animation-duration, 200ms) ease;
      }

      .chip.interactive {
        cursor: pointer;
      }

      .chip.interactive:hover {
        background: var(
          --ct-theme-color-surface-hover,
          var(--ct-color-gray-200, #eeeeee)
        );
      }

      /* Variant: primary (blue - for mentions) */
      .chip.primary {
        background: var(
          --ct-theme-color-primary-surface,
          var(--ct-color-blue-50, #eff6ff)
        );
        border-color: var(
          --ct-theme-color-primary,
          var(--ct-color-blue-200, #bfdbfe)
        );
        color: var(
          --ct-theme-color-primary,
          var(--ct-color-blue-700, #1d4ed8)
        );
      }

      /* Variant: accent (purple - for clipboard) */
      .chip.accent {
        background: var(
          --ct-theme-color-accent-surface,
          var(--ct-color-purple-50, #faf5ff)
        );
        border-color: var(
          --ct-theme-color-accent,
          var(--ct-color-purple-200, #e9d5ff)
        );
        color: var(
          --ct-theme-color-accent,
          var(--ct-color-purple-700, #7c3aed)
        );
      }

      .chip-icon {
        display: flex;
        align-items: center;
        font-size: 0.8125rem;
        line-height: 1;
      }

      .chip-label {
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .chip-remove {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 0.75rem;
        height: 0.75rem;
        border-radius: 50%;
        cursor: pointer;
        transition: background-color 0.1s;
        color: currentColor;
        opacity: 0.6;
      }

      .chip-remove:hover {
        background: rgba(0, 0, 0, 0.1);
        opacity: 1;
      }
    `,
  ];

  @property({ type: String })
  label = "";

  @property({ type: String })
  variant: "default" | "primary" | "accent" = "default";

  @property({ type: Boolean })
  removable = false;

  @property({ type: Boolean })
  interactive = false;

  private _handleRemove(e: Event): void {
    e.stopPropagation();
    this.emit("ct-remove");
  }

  private _handleClick(): void {
    if (this.interactive) {
      this.emit("ct-click");
    }
  }

  override render() {
    const classes = [
      "chip",
      this.variant,
      this.interactive && "interactive",
    ].filter(Boolean).join(" ");

    return html`
      <div class="${classes}" @click="${this._handleClick}">
        <slot name="icon" class="chip-icon"></slot>
        <span class="chip-label">
          <slot>${this.label}</slot>
        </span>
        ${this.removable
          ? html`
            <span class="chip-remove" @click="${this._handleRemove}">×</span>
          `
          : ""}
      </div>
    `;
  }
}

customElements.define("ct-chip", CTChip);
