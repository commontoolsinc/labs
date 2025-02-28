import { css, html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
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
@customElement("common-iframe")
export class CommonIframeElement extends LitElement {
  @property({ type: String })
  accessor src = "";
  // HACK: The UI framework already translates the top level cell into updated
  // properties, but we want to only have to deal with one type of listening, so
  // we'll add a an extra level of indirection with the "context" property.
  @property({ type: Object })
  accessor context: object;

  @state()
  accessor errorDetails: IPC.GuestError | null = null;

  static override styles = css`
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
    this.errorDetails = e.detail;
  }

  private dismissError() {
    this.errorDetails = null;
  }

  private fixError() {
    this.dispatchEvent(
      new CustomEvent("fix", { detail: this.errorDetails, bubbles: true }),
    );
    this.errorDetails = null;
  }

  override render() {
    return html`
      <common-iframe-sandbox
        .context=${this.context}
        .src=${this.src}
        height="100%"
        width="100%"
        style="border: none;"
        @load=${this.onLoad}
        @error=${this.onError}
      ></iframe>
      ${
      this.errorDetails
        ? html`
            <div class="error-modal">
              <div class="error-content">
                <h2>Error</h2>
                <p><strong>Description:</strong> ${this.errorDetails.description}</p>
                <p><strong>Source:</strong> ${this.errorDetails.source}</p>
                <p><strong>Line:</strong> ${this.errorDetails.lineno}</p>
                <p><strong>Column:</strong> ${this.errorDetails.colno}</p>
                <pre><code>${this.errorDetails.stacktrace}</code></pre>
                <div class="error-actions">
                  <button @click=${this.fixError}>Fix</button>
                  <button @click=${this.dismissError}>Dismiss</button>
                </div>
              </div>
            </div>
          `
        : ""
    }
    `;
  }
}
