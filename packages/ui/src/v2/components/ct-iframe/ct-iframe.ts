import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import {
  CommonIframeSandboxElement as _,
  IPC,
} from "@commontools/iframe-sandbox";

/**
 * CTIframe - An iframe to execute arbitrary scripts
 *
 * See `@commontools/iframe-sandbox` for security details.
 *
 * @element ct-iframe
 *
 * @attr {string} src - String representation of HTML content to load within an iframe
 * @attr {object} context - Cell context
 *
 * @event {CustomEvent} load - The iframe was successfully loaded
 * @event {CustomEvent} fix - Dispatched when user clicks "Fix" on an error modal
 *
 * @example
 * <ct-iframe src="<html>...</html>" .context=${cellContext}></ct-iframe>
 */
export class CTIframe extends BaseElement {
  static override properties = {
    src: { type: String },
    context: { type: Object },
    _errorDetails: { state: true },
  };

  declare src: string;
  // HACK: The UI framework already translates the top level cell into updated
  // properties, but we want to only have to deal with one type of listening, so
  // we'll add a an extra level of indirection with the "context" property.
  declare context: object | null;
  declare _errorDetails: IPC.GuestError | null;

  constructor() {
    super();
    this.src = "";
    this.context = null;
    this._errorDetails = null;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      .error-modal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 9999;
      }

      .error-content {
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-white, #ffffff)
        );
        padding: var(--ct-theme-spacing-loose, 1.25rem);
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        max-width: 80%;
        max-height: 80%;
        overflow: auto;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      }

      .error-content h2 {
        margin: 0 0 1rem;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .error-content p {
        margin: 0.5rem 0;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .error-content pre {
        background-color: var(
          --ct-theme-color-surface-hover,
          var(--ct-color-gray-100, #f3f4f6)
        );
        padding: 1rem;
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-sm, 0.25rem)
        );
        overflow: auto;
        font-family: monospace;
      }

      .error-actions {
        margin-top: 1.25rem;
        display: flex;
        justify-content: flex-end;
        gap: 0.75rem;
      }

      .error-actions button {
        padding: 0.5rem 1rem;
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-300, #d1d5db));
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-white, #ffffff)
        );
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 500;
        transition: all 0.2s ease;
      }

      .error-actions button:hover {
        background-color: var(
          --ct-theme-color-surface-hover,
          var(--ct-color-gray-100, #f3f4f6)
        );
      }

      .error-actions button:first-child {
        background-color: var(
          --ct-theme-color-primary,
          var(--ct-color-primary, #3b82f6)
        );
        color: var(
          --ct-theme-color-primary-foreground,
          var(--ct-color-white, #ffffff)
        );
        border-color: var(
          --ct-theme-color-primary,
          var(--ct-color-primary, #3b82f6)
        );
      }

      .error-actions button:first-child:hover {
        opacity: 0.9;
      }
    `,
  ];

  private onLoad() {
    this.emit("load");
  }

  private onError(e: CustomEvent) {
    this._errorDetails = e.detail;
  }

  private dismissError() {
    this._errorDetails = null;
  }

  private fixError() {
    this.emit("fix", this._errorDetails);
    this._errorDetails = null;
  }

  override render() {
    return html`
      <common-iframe-sandbox
        .context="${this.context}"
        .src="${this.src}"
        height="100%"
        width="100%"
        style="border: none;"
        @load="${this.onLoad}"
        @error="${this.onError}"
      ></common-iframe-sandbox>
      ${this._errorDetails
        ? html`
          <div class="error-modal">
            <div class="error-content">
              <h2>Error</h2>
              <p><strong>Description:</strong> ${this._errorDetails
                .description}</p>
              <p><strong>Source:</strong> ${this._errorDetails.source}</p>
              <p><strong>Line:</strong> ${this._errorDetails.lineno}</p>
              <p><strong>Column:</strong> ${this._errorDetails.colno}</p>
              <pre><code>${this._errorDetails.stacktrace}</code></pre>
              <div class="error-actions">
                <button @click="${this.fixError}">Fix</button>
                <button @click="${this.dismissError}">Dismiss</button>
              </div>
            </div>
          </div>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("ct-iframe", CTIframe);
