import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import type { ComponentSize } from "../theme-context.ts";

/**
 * CFChip - Reusable pill/chip component
 *
 * @element cf-chip
 *
 * @attr {string} label - Chip label text to display
 * @attr {string} variant - Visual variant: "default" | "primary" | "accent" (default: "default")
 * @attr {string} size - Size variant: "xs" | "sm" | "md" | "lg" | "xl" (default: "sm")
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
        gap: var(--cf-size-sm-spacing);
        padding: var(--cf-size-sm-padding-v) var(--cf-size-sm-padding-h);
        background: var(
          --cf-chip-background,
          var(
            --cf-theme-color-surface,
            var(--cf-colors-gray-100, #f2f3f6)
          )
        );
        color: var(
          --cf-chip-color,
          var(
            --cf-theme-color-text,
            var(--cf-colors-gray-900, #16181d)
          )
        );
        border: 1px solid
          var(
            --cf-chip-border-color,
            var(
              --cf-theme-color-border,
              var(--cf-colors-gray-300, #d5d7dd)
            )
          );
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-full, 9999px)
        );
        font-size: var(--cf-size-sm-font-size);
        line-height: var(--cf-size-sm-line-height);
        user-select: none;
        transition:
          background-color var(--cf-theme-animation-duration, 200ms) ease,
          border-color var(--cf-theme-animation-duration, 200ms) ease;
        }

        :host([size="xs"]) .chip {
          padding: var(--cf-size-xs-padding-v) var(--cf-size-xs-padding-h);
          font-size: var(--cf-size-xs-font-size);
          line-height: var(--cf-size-xs-line-height);
          gap: var(--cf-size-xs-spacing);
        }

        /* sm is default — no override needed */

        :host([size="md"]) .chip {
          padding: var(--cf-size-md-padding-v) var(--cf-size-md-padding-h);
          font-size: var(--cf-size-md-font-size);
          line-height: var(--cf-size-md-line-height);
          gap: var(--cf-size-md-spacing);
        }

        :host([size="lg"]) .chip {
          padding: var(--cf-size-lg-padding-v) var(--cf-size-lg-padding-h);
          font-size: var(--cf-size-lg-font-size);
          line-height: var(--cf-size-lg-line-height);
          gap: var(--cf-size-lg-spacing);
        }

        :host([size="xl"]) .chip {
          padding: var(--cf-size-xl-padding-v) var(--cf-size-xl-padding-h);
          font-size: var(--cf-size-xl-font-size);
          line-height: var(--cf-size-xl-line-height);
          gap: var(--cf-size-xl-spacing);
        }

        .chip.interactive {
          cursor: pointer;
        }

        .chip.interactive:hover {
          background: var(
            --cf-theme-color-surface-hover,
            var(--cf-colors-gray-200, #eceef1)
          );
        }

        /* Variant: primary (blue - for mentions) */
        .chip.primary {
          background: var(
            --cf-chip-primary-background,
            color-mix(
              in srgb,
              var(
                --cf-theme-color-primary,
                var(--cf-colors-primary-500, #4979fa)
              ) 12%,
              var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
            )
          );
          border-color: var(
            --cf-chip-primary-border-color,
            color-mix(
              in srgb,
              var(
                --cf-theme-color-primary,
                var(--cf-colors-primary-500, #4979fa)
              ) 28%,
              var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
            )
          );
          color: var(
            --cf-chip-primary-color,
            var(--cf-theme-color-primary, var(--cf-colors-primary-700, #376bf9))
          );
        }

        /* Variant: accent (purple - for clipboard) */
        .chip.accent {
          background: var(
            --cf-chip-accent-background,
            color-mix(
              in srgb,
              var(--cf-theme-color-accent, var(--cf-colors-purple, #8952fd)) 12%,
              var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
            )
          );
          border-color: var(
            --cf-chip-accent-border-color,
            color-mix(
              in srgb,
              var(--cf-theme-color-accent, var(--cf-colors-purple, #8952fd)) 28%,
              var(--cf-theme-color-surface, var(--cf-colors-gray-50, #ffffff))
            )
          );
          color: var(
            --cf-chip-accent-color,
            var(--cf-theme-color-accent, var(--cf-colors-purple, #8952fd))
          );
        }

        .chip-icon {
          display: flex;
          align-items: center;
          font-size: 0.8125rem;
          line-height: 1;
        }

        :host:not(:has([slot="icon"])) .chip-icon {
          display: none;
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
    accessor label = "";

    @property({ type: String })
    accessor variant: "default" | "primary" | "accent" = "default";

    @property({ type: Boolean })
    accessor removable = false;

    @property({ type: Boolean })
    accessor interactive = false;

    @property({ type: String, reflect: true })
    accessor size: ComponentSize = "sm";

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
