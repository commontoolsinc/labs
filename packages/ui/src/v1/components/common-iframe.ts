import { css, html, LitElement } from "lit";
import {
  CommonIframeSandboxElement as _,
  IPC,
} from "@commontools/iframe-sandbox";

// @summary An iframe to execute arbitrary scripts. See `@commontools/iframe-sandbox`
//          for security details.
// @tag common-iframe
// @prop {string} src - String representation of HTML content to load within an iframe.
// @prop context - Cell context.
// @event {CustomEvent} load - The iframe was successfully loaded.
export class CommonIframeElement extends LitElement {
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

  static override styles = css`
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
    }

    .error-content {
      background-color: white;
      padding: 20px;
      border-radius: 5px;
      max-width: 80%;
      max-height: 80%;
      overflow: auto;
    }

    .error-actions {
      margin-top: 20px;
      display: flex;
      justify-content: flex-end;
    }

    .error-actions button {
      margin-left: 10px;
    }
  `;

  private onLoad() {
    this.dispatchEvent(new CustomEvent("load"));
  }

  private onError(e: CustomEvent) {
    this._errorDetails = e.detail;
  }

  private dismissError() {
    this._errorDetails = null;
  }

  private fixError() {
    this.dispatchEvent(
      new CustomEvent("fix", { detail: this._errorDetails, bubbles: true }),
    );
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
globalThis.customElements.define("common-iframe", CommonIframeElement);
