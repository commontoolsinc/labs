import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFChip - Reusable pill/chip component
 *
 * @element cf-chip
 *
 * @attr {string} label - Chip label text to display
 * @attr {string} variant - Visual variant: "default" | "primary" | "accent" (default: "default")
 * @attr {boolean} removable - Whether to show remove button (default: false)
 * @attr {boolean} interactive - Whether chip is clickable (default: false)
 *
 * @fires cf-remove - Fired when remove button is clicked
 * @fires cf-click - Fired when chip is clicked (if interactive)
 *
 * @slot icon - Optional icon before the label
 * @slot - Main content (overrides label)
 *
 * @example
 * <cf-chip label="Tools" variant="default"></cf-chip>
 * <cf-chip label="Alice" variant="primary" removable></cf-chip>
 */
export class CFChip extends BaseElement {
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
          --cf-theme-color-surface,
          var(--cf-color-gray-100, #f5f5f5)
        );
        color: var(
          --cf-theme-color-text,
          var(--cf-color-gray-900, #212121)
        );
        border: 1px solid
          var(--cf-theme-color-border, var(--cf-color-gray-300, #e0e0e0));
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-full, 9999px)
        );
        font-size: 0.8125rem;
        line-height: 1;
        user-select: none;
        transition:
          background-color var(--cf-theme-animation-duration, 200ms) ease,
          border-color var(--cf-theme-animation-duration, 200ms) ease;
        }

        .chip.interactive {
          cursor: pointer;
        }

        .chip.interactive:hover {
          background: var(
            --cf-theme-color-surface-hover,
            var(--cf-color-gray-200, #eeeeee)
          );
        }

        /* Variant: primary (blue - for mentions) */
        .chip.primary {
          background: var(
            --cf-theme-color-primary-surface,
            var(--cf-color-blue-50, #eff6ff)
          );
          border-color: var(
            --cf-theme-color-primary,
            var(--cf-color-blue-200, #bfdbfe)
          );
          color: var(
            --cf-theme-color-primary,
            var(--cf-color-blue-700, #1d4ed8)
          );
        }

        /* Variant: accent (purple - for clipboard) */
        .chip.accent {
          background: var(
            --cf-theme-color-accent-surface,
            var(--cf-color-purple-50, #faf5ff)
          );
          border-color: var(
            --cf-theme-color-accent,
            var(--cf-color-purple-200, #e9d5ff)
          );
          color: var(
            --cf-theme-color-accent,
            var(--cf-color-purple-700, #7c3aed)
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
      this.emit("cf-remove");
    }

    private _handleClick(): void {
      if (this.interactive) {
        this.emit("cf-click");
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

  customElements.define("cf-chip", CFChip);
