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
        padding: 0.3125rem 0.75rem;
        background: var(
          --ct-theme-color-surface,
          #f3f1eb
        );
        color: var(
          --ct-theme-color-text,
          #2c3227
        );
        border: 1.5px solid var(--ct-theme-color-border, #d4d2c8);
        border-radius: 9999px;
        font-size: 0.875rem;
        font-weight: 700;
        line-height: 1;
        user-select: none;
        transition:
          background-color var(--ct-theme-animation-duration, 200ms) ease,
          border-color var(--ct-theme-animation-duration, 200ms) ease;
        -webkit-font-smoothing: antialiased;
      }

      .chip.interactive {
        cursor: pointer;
      }

      .chip.interactive:hover {
        background: var(
          --ct-theme-color-surface-hover,
          #e8e6dd
        );
      }

      .chip.interactive:active {
        transform: scale(0.96);
        transition-duration: 0.1s;
      }

      /* Variant: primary (green - for mentions) */
      .chip.primary {
        background: #ebf5ec;
        border-color: #b8dabc;
        color: var(
          --ct-theme-color-primary,
          #2d8c3c
        );
      }

      .chip.primary.interactive:hover {
        background: #dcf0de;
      }

      /* Variant: accent (copper - for clipboard) */
      .chip.accent {
        background: #fdf3eb;
        border-color: #e8c9ae;
        color: var(
          --ct-theme-color-accent,
          #c87137
        );
      }

      .chip.accent.interactive:hover {
        background: #faeadc;
      }

      .chip-icon {
        display: flex;
        align-items: center;
        font-size: 0.875rem;
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
        width: 0.875rem;
        height: 0.875rem;
        border-radius: 50%;
        cursor: pointer;
        transition: background-color 0.1s;
        color: currentColor;
        opacity: 0.5;
      }

      .chip-remove:hover {
        background: rgba(44, 50, 39, 0.12);
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
