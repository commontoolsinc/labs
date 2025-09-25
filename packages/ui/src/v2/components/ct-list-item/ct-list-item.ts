import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";

/**
 * ct-list-item — Row primitive for lists
 *
 * Slots:
 * - leading: Icon/avatar at the start of the row
 * - default: Primary content (title or custom node)
 * - subtitle: Secondary line below primary content
 * - meta: Right-aligned metadata (time, count)
 * - actions: Inline action controls; do not trigger activation
 *
 * States:
 * - selected: Highlighted selection state
 * - active: Emphasized active state (e.g., current route)
 * - disabled: Non-interactive
 *
 * Events:
 * - ct-activate: Fired when the row is activated (click/Enter/Space)
 *
 * @element ct-list-item
 */
export class CTListItem extends BaseElement {
  /** Selected (highlight) state */
  @property({ type: Boolean, reflect: true })
  selected = false;

  /** Active (current) state */
  @property({ type: Boolean, reflect: true })
  active = false;

  /** Disabled (non-interactive) state */
  @property({ type: Boolean, reflect: true })
  disabled = false;

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--ct-theme-font-family, inherit);
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .row {
        display: grid;
        grid-template-columns: auto 1fr auto auto;
        grid-template-areas: "leading main meta actions";
        align-items: center;
        gap: var(--ct-spacing-3);
        padding: var(--ct-spacing-2) var(--ct-spacing-3);
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        transition: background-color var(--ct-theme-animation-duration, 150ms)
          var(--ct-transition-timing-ease);
        cursor: pointer;
        user-select: none;
      }

      :host([disabled]) .row {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .row:hover {
        background: var(
          --ct-theme-color-surface-hover,
          var(--ct-color-gray-100, #f3f4f6)
        );
        box-shadow: inset 0 0 0 1px
          var(--ct-theme-color-border, var(--ct-color-gray-200, #e5e7eb));
        }

        :host([selected]) .row {
          background: var(
            --ct-theme-color-surface,
            var(--ct-color-gray-50, #f9fafb)
          );
          box-shadow: inset 0 0 0 1px
            var(--ct-theme-color-primary, var(--ct-color-primary, #3b82f6));
          }

          :host([active]) .row {
            background: var(
              --ct-theme-color-surface-hover,
              var(--ct-color-gray-100, #f3f4f6)
            );
            box-shadow: inset 0 0 0 1px
              var(--ct-theme-color-primary, var(--ct-color-primary, #3b82f6));
            }

            .leading {
              grid-area: leading;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              width: 1.5rem;
              height: 1.5rem;
              color: var(--ct-theme-color-text-muted, var(--ct-color-gray-600, #4b5563));
            }

            .main {
              grid-area: main;
              min-width: 0; /* allow text truncation */
              display: grid;
              grid-template-rows: auto auto;
              align-items: center;
            }

            .title {
              font-size: var(--ct-font-size-sm);
              font-weight: var(--ct-font-weight-medium);
              line-height: var(--ct-line-height-snug);
              color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }

            .subtitle {
              font-size: var(--ct-font-size-xs);
              color: var(--ct-theme-color-text-muted, var(--ct-color-gray-600, #4b5563));
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }

            .meta {
              grid-area: meta;
              margin-left: var(--ct-spacing-2);
              color: var(--ct-theme-color-text-muted, var(--ct-color-gray-600, #4b5563));
              font-size: var(--ct-font-size-xs);
            }

            .actions {
              grid-area: actions;
              display: inline-flex;
              align-items: center;
              gap: var(--ct-spacing-1);
              opacity: 0;
              transition: opacity var(--ct-transition-duration-fast)
                var(--ct-transition-timing-ease);
              }

              .row:hover .actions,
              :host([active]) .actions,
              :host([selected]) .actions {
                opacity: 1;
              }

              ::slotted([slot="actions"]) {
                pointer-events: auto;
              }
            `,
          ];

          override firstUpdated(
            changed: Map<string | number | symbol, unknown>,
          ) {
            super.firstUpdated(changed);
            this.#applyTheme();
          }

          override updated(changed: Map<string | number | symbol, unknown>) {
            super.updated(changed);
            if (changed.has("theme")) this.#applyTheme();
          }

          #applyTheme() {
            applyThemeToElement(this, this.theme ?? defaultTheme);
          }

          override connectedCallback(): void {
            super.connectedCallback();
            this.setAttribute("role", "listitem");
            this.tabIndex = this.disabled ? -1 : 0;
            this.addEventListener("click", this.#onActivate);
            this.addEventListener("keydown", this.#onKeyDown);
          }

          override disconnectedCallback(): void {
            super.disconnectedCallback();
            this.removeEventListener("click", this.#onActivate);
            this.removeEventListener("keydown", this.#onKeyDown);
          }

          #inActionsPath(e: Event): boolean {
            const path = e.composedPath();
            for (const el of path) {
              if (!(el instanceof HTMLElement)) continue;
              // If element is slotted into actions or is an interactive control
              if (
                el.getAttribute && el.getAttribute("slot") === "actions" ||
                el.tagName === "BUTTON" ||
                el.tagName === "A" ||
                el.getAttribute("data-ct-action") !== null
              ) {
                return true;
              }
            }
            return false;
          }

          #onActivate = (e: Event) => {
            if (this.disabled) return;
            if (this.#inActionsPath(e)) return;
            this.emit("ct-activate");
          };

          #onKeyDown = (e: KeyboardEvent) => {
            if (this.disabled) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              this.emit("ct-activate");
            }
          };

          override render() {
            return html`
              <div class="row">
                <span class="leading"><slot name="leading"></slot></span>
                <div class="main">
                  <div class="title"><slot></slot></div>
                  <div class="subtitle"><slot name="subtitle"></slot></div>
                </div>
                <div class="meta"><slot name="meta"></slot></div>
                <div class="actions"><slot name="actions"></slot></div>
              </div>
            `;
          }
        }

        globalThis.customElements.define("ct-list-item", CTListItem);
