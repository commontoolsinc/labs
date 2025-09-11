import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { consume } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import type {
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commontools/api";
import {
  applyThemeToElement,
  type CTTheme,
  resolveColor,
  resolveColorScheme,
  themeContext,
} from "../theme-context.ts";

export type ToolCallState = "pending" | "success" | "error";

/**
 * CTToolCall - Expandable tool call display component
 *
 * @element ct-tool-call
 *
 * @attr {object} toolCall - The tool call data (BuiltInLLMToolCallPart)
 * @attr {object} toolResult - The tool result data (BuiltInLLMToolResultPart, optional)
 * @attr {boolean} expanded - Whether the tool call details are expanded
 *
 * @example
 * <ct-tool-call
 *   .toolCall=${toolCall}
 *   .toolResult=${toolResult}
 *   expanded
 * ></ct-tool-call>
 */
export class CTToolCall extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .tool-call-container {
        border: 1px solid var(--ct-theme-border, var(--ct-color-gray-200, #e5e7eb));
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius, 0.25rem)
        );
        background-color: var(--ct-theme-surface, var(--ct-color-gray-50, #f9fafb));
        overflow: hidden;
        transition: all var(--ct-theme-animation-duration, 0.2s) ease;
      }

      .tool-call-header {
        display: flex;
        align-items: center;
        gap: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem));
        padding: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem))
          var(--ct-theme-spacing-loose, var(--ct-spacing-3, 0.75rem));
        cursor: pointer;
        user-select: none;
        font-size: 0.875rem;
        font-family: var(
          --ct-theme-mono-font-family,
          var(
            --ct-font-mono,
            ui-monospace,
            "Cascadia Code",
            "Source Code Pro",
            Menlo,
            Consolas,
            "DejaVu Sans Mono",
            monospace
          )
        );
        color: var(--ct-theme-text, var(--ct-color-gray-700, #374151));
        background: transparent;
        border: none;
        width: 100%;
        text-align: left;
      }

      .tool-call-header:hover {
        background-color: var(
          --ct-theme-surface-hover,
          var(--ct-color-gray-100, #f3f4f6)
        );
      }

      .tool-call-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }

      .tool-call-name {
        font-weight: 400;
        flex-grow: 1;
      }

      .tool-call-status {
        display: flex;
        align-items: center;
        gap: var(--ct-theme-spacing-tight, var(--ct-spacing-1, 0.25rem));
        font-size: 0.75rem;
        font-family: var(
          --ct-theme-mono-font-family,
          var(
            --ct-font-mono,
            ui-monospace,
            "Cascadia Code",
            "Source Code Pro",
            Menlo,
            Consolas,
            "DejaVu Sans Mono",
            monospace
          )
        );
      }

      .chevron {
        width: 16px;
        height: 16px;
        transition: transform var(--ct-theme-animation-duration, 0.2s) ease;
        color: var(--ct-theme-text-muted, var(--ct-color-gray-400, #9ca3af));
      }

      .chevron.expanded {
        transform: rotate(90deg);
      }

      .tool-call-content {
        border-top: 1px solid
          var(--ct-theme-border, var(--ct-color-gray-200, #e5e7eb));
        background-color: var(
          --ct-theme-background,
          var(--ct-color-white, #ffffff)
        );
      }

      .tool-section {
        padding: var(--ct-theme-spacing-loose, var(--ct-spacing-3, 0.75rem));
      }

      .tool-section:not(:last-child) {
        border-bottom: 1px solid
          var(--ct-theme-border-muted, var(--ct-color-gray-100, #f3f4f6));
        }

        .tool-section-title {
          font-weight: 600;
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.025em;
          color: var(--ct-theme-text-muted, var(--ct-color-gray-600, #4b5563));
          margin-bottom: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem));
        }

        .tool-section-content {
          font-family: var(
            --ct-theme-mono-font-family,
            var(
              --ct-font-mono,
              ui-monospace,
              "Cascadia Code",
              "Source Code Pro",
              Menlo,
              Consolas,
              "DejaVu Sans Mono",
              monospace
            )
          );
          font-size: 0.75rem;
          background-color: var(--ct-theme-surface, var(--ct-color-gray-50, #f9fafb));
          border: 1px solid var(--ct-theme-border, var(--ct-color-gray-200, #e5e7eb));
          border-radius: var(
            --ct-theme-border-radius,
            var(--ct-border-radius-sm, 0.125rem)
          );
          padding: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem));
          white-space: pre-wrap;
          word-break: break-word;
          overflow-x: auto;
          max-height: 200px;
          overflow-y: auto;
        }

        /* Status styling */
        .status-pending {
          color: var(--ct-theme-primary, var(--ct-color-blue-600, #2563eb));
        }

        .status-success {
          color: var(--ct-theme-success, var(--ct-color-green-600, #16a34a));
        }

        .status-error {
          color: var(--ct-theme-error, var(--ct-color-red-600, #dc2626));
        }

        .error-content {
          color: var(--ct-theme-error, var(--ct-color-red-700, #b91c1c));
          background-color: var(
            --ct-theme-error-background,
            var(--ct-color-red-50, #fef2f2)
          );
          border-color: var(
            --ct-theme-error-border,
            var(--ct-color-red-200, #fecaca)
          );
        }
      `,
    ];

    @property({ type: Object })
    declare call: BuiltInLLMToolCallPart;

    @property({ type: Object })
    declare result?: BuiltInLLMToolResultPart;

    @property({ type: Boolean, reflect: true })
    declare expanded: boolean;

    @consume({ context: themeContext, subscribe: true })
    @property({ attribute: false })
    declare theme?: CTTheme;

    constructor() {
      super();
      this.expanded = false;
    }

    override firstUpdated(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
      super.firstUpdated(changedProperties);
      this._updateThemeProperties();
    }

    override updated(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
      super.updated(changedProperties);
      if (changedProperties.has("theme")) {
        this._updateThemeProperties();
      }
    }

    private _updateThemeProperties() {
      if (!this.theme) return;

      // Apply standard theme properties
      applyThemeToElement(this, this.theme);

      // Add tool-call specific theme properties
      const colorScheme = resolveColorScheme(this.theme.colorScheme);
      this.style.setProperty(
        "--ct-theme-error-background",
        resolveColor(this.theme.colors.background, colorScheme),
      );
      this.style.setProperty(
        "--ct-theme-error-border",
        resolveColor(this.theme.colors.border, colorScheme),
      );
    }

    private get _state(): ToolCallState {
      if (this.result) {
        return "success";
      }
      return "pending";
    }

    private get _statusIcon(): string {
      switch (this._state) {
        case "pending":
          return "🔧";
        case "success":
          return "✅";
        case "error":
          return "❌";
        default:
          return "🔧";
      }
    }

    private get _statusText(): string {
      switch (this._state) {
        case "pending":
          return "Running";
        case "success":
          return "Complete";
        case "error":
          return "Error";
        default:
          return "Pending";
      }
    }

    private _toggleExpanded() {
      this.expanded = !this.expanded;
    }

    private _formatOutput(output: BuiltInLLMToolResultPart["output"]): string {
      if (output.type === "text") {
        return output.value;
      } else {
        try {
          return JSON.stringify(output.value, null, 2);
        } catch {
          return String(output.value);
        }
      }
    }

    private _formatJSON(data: any): string {
      try {
        return JSON.stringify(data, null, 2);
      } catch {
        return String(data);
      }
    }

    private _renderContent() {
      if (!this.expanded) {
        return null;
      }

      return html`
        <div class="tool-call-content">
          <div class="tool-section">
            <div class="tool-section-title">Input</div>
            <pre class="tool-section-content">${this._formatJSON(
              this.call.input,
            )}</pre>
          </div>
          ${this.result
            ? html`
              <div class="tool-section">
                <div class="tool-section-title">
                  ${this._state === "error" ? "Error" : "Output"}
                </div>
                <pre
                  class="tool-section-content ${this._state === "error"
                    ? "error-content"
                    : ""}"
                >${this._formatJSON(this.result.output)}</pre>
              </div>
            `
            : null}
        </div>
      `;
    }

    override render() {
      const statusClass = `status-${this._state}`;

      return html`
        <div class="tool-call-container">
          <button class="tool-call-header" @click="${this._toggleExpanded}">
            <span class="tool-call-icon">${this._statusIcon}</span>
            <span class="tool-call-name">${this.call?.toolName}</span>
            <span class="tool-call-status ${statusClass}">
              ${this._statusText}
            </span>
            <svg
              class="chevron ${this.expanded ? "expanded" : ""}"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
          ${this._renderContent()}
        </div>
      `;
    }
  }

  globalThis.customElements.define("ct-tool-call", CTToolCall);
