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
        gap: var(--ct-theme-spacing-tight, var(--ct-spacing-1, 0.25rem));
        padding: 0.25rem 0.625rem;
        background: var(
          --ct-theme-surface,
          var(--ct-color-gray-100, #f3f4f6)
        );
        color: var(
          --ct-theme-color-text,
          var(--ct-color-gray-900, #111827)
        );
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-300, #d1d5db));
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-radius-full, 9999px)
        );
        font-size: 0.8125rem;
        line-height: 1;
        user-select: none;
        transition:
          background-color var(--ct-theme-animation-duration, 150ms) ease,
          border-color var(--ct-theme-animation-duration, 150ms) ease;
      }

      .chip.interactive {
        cursor: pointer;
      }

      .chip.interactive:hover {
        background: var(
          --ct-theme-color-surface-hover,
          var(--ct-color-gray-200, #e5e7eb)
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
        font-size: 0.875rem;
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
        width: 1rem;
        height: 1rem;
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
      <div class=${classes} @click=${this._handleClick}>
        <slot name="icon" class="chip-icon"></slot>
        <span class="chip-label">
          <slot>${this.label}</slot>
        </span>
        ${this.removable
          ? html`
              <span class="chip-remove" @click=${this._handleRemove}>×</span>
            `
          : ""}
      </div>
    `;
  }
}

customElements.define("ct-chip", CTChip);
