import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Ref, createRef, ref } from "lit/directives/ref.js";
import { IframeIPC } from "../index.js";

// This CSP directive uses 'unsafe-inline' to allow
// origin-less styles and scripts to be used, defeating
// many traditional uses of CSP.
const CSP = "" +
  // Disable all fetch directives by default
  "default-src 'none';" +
  // Allow CDN scripts, unsafe inline.
  "script-src 'unsafe-inline' unpkg.com cdn.tailwindcss.com;" +
  // unsafe inline.
  "style-src 'unsafe-inline';";

// @summary A sandboxed iframe to execute arbitrary scripts.
// @tag common-iframe
// @prop {string} src - String representation of HTML content to load within an iframe.
// @prop context - Cell context.
// @event {CustomEvent} error - An error from the iframe.
// @event {CustomEvent} load - The iframe was successfully loaded.
//
// ## Missing Functionality
//
// * Support updating the `src` property.
// * Flushing subscriptions inbetween frame loads.
//
// ## Incomplete Security Considerations
//
// * Exposing iframe status to outer content could be considered leaky,
//   though all content is inlined, not HTTP URLs.
//   https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#error_and_load_event_behavior
//
@customElement("common-iframe")
export class CommonIframeElement extends LitElement {
  @property({ type: String }) src = "";
  // HACK: The UI framework already translates the top level cell into updated
  // properties, but we want to only have to deal with one type of listening, so
  // we'll add a an extra level of indirection with the "context" property.
  //@property({ type: Object }) context?: Cell<any> | any;
  @property({ type: Object }) context?: object;

  @state() private errorDetails: IframeIPC.GuestError | null = null;

  private iframeRef: Ref<HTMLIFrameElement> = createRef();

  private subscriptions: Map<string, any> = new Map();

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

  private handleMessage = (event: MessageEvent) => {
    if (event.data?.source == "react-devtools-content-script") {
      return;
    }

    if (event.source !== this.iframeRef.value?.contentWindow) {
      return;
    }

    const IframeHandler = IframeIPC.getIframeContextHandler();
    if (IframeHandler == null) {
      console.error("common-iframe: No iframe handler defined.");
      return;
    }

    if (!this.context) {
      console.error("common-iframe: missing `context`.");
      return;
    }

    if (!IframeIPC.isGuestMessage(event.data)) {
      console.error("common-iframe: Malformed message from guest.");
      return;
    }

    const message: IframeIPC.GuestMessage = event.data;

    switch (message.type) {
      case IframeIPC.GuestMessageType.Error: {
        const { description, source, lineno, colno, stacktrace } = message.data;
        this.errorDetails = { description, source, lineno, colno, stacktrace };
        console.error("Error details:", {
          description,
          source,
          lineno,
          colno,
          stacktrace,
        });
        this.dispatchEvent(new CustomEvent("error", {
          detail: this.errorDetails,
        }));
        return;
      }

      case IframeIPC.GuestMessageType.Read: {
        const key = message.data;
        const value = IframeHandler.read(this.context, key);
        // TODO: This might cause infinite loops, since the data can be a graph.
        const response: IframeIPC.HostMessage = {
          type: IframeIPC.HostMessageType.Update,
          data: [key, copyJSON(value)]
        }
        this.iframeRef.value?.contentWindow?.postMessage(response, "*");
        return;
      }

      case IframeIPC.GuestMessageType.Write: {
        const [key, value] = message.data;
        IframeHandler.write(this.context, key, value);
        return;
      }

      case IframeIPC.GuestMessageType.Subscribe: {
        const key = message.data;

        if (this.subscriptions.has(key)) {
          console.warn("common-iframe: Already subscribed to `${key}`");
          return;
        }
        let receipt = IframeHandler.subscribe(this.context, key, (key, value) => this.notifySubscribers(key, value));
        this.subscriptions.set(key, receipt);
        return;
      }

      case IframeIPC.GuestMessageType.Unsubscribe: {
        const key = message.data;
        let receipt = this.subscriptions.get(key);
        if (!receipt) {
          return;
        }
        IframeHandler.unsubscribe(this.context, receipt);
        this.subscriptions.delete(key);
        return;
      }
    };
  }

  private notifySubscribers(key: string, value: any) {
    // TODO: This might cause infinite loops, since the data can be a graph.
    // /!\ Why is this serialized?
    const copy =
      value !== undefined ? JSON.parse(JSON.stringify(value)) : undefined;
    const response: IframeIPC.HostMessage = {
      type: IframeIPC.HostMessageType.Update,
      data: [key, copy],
    }
    this.iframeRef.value?.contentWindow?.postMessage(response, "*");
  }

  private boundHandleMessage = this.handleMessage.bind(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("message", this.boundHandleMessage);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("message", this.boundHandleMessage);
  }

  private handleLoad() {
    this.dispatchEvent(new CustomEvent("load"));
  }

  private dismissError() {
    this.errorDetails = null;
  }

  private fixError() {
    this.dispatchEvent(
      new CustomEvent("fix", { detail: this.errorDetails, bubbles: true })
    );
    this.errorDetails = null;
  }

  override render() {
    return html`
      <iframe
        ${ref(this.iframeRef)}
        sandbox="allow-scripts allow-forms allow-pointer-lock"
        csp="${CSP}"
        .srcdoc=${this.src}
        height="100%"
        width="100%"
        style="border: none;"
        @load=${this.handleLoad}
      ></iframe>
      ${this.errorDetails
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
        : ""}
    `;
  }
}

// This applies a de/serialization cycle on `input` to create
// a clone.
//
// /!\ Lacking context for the original purpose of this function.
// /!\ I suspect this could be removed as unclear where we use/need
// /!\ auto-parsing JSON-ish strings, and unnecessary cloning
// /!\ an object before sending over iframe, invoking structured clone algorithm,
// /!\ duplicating this potentially costly serialization.
function copyJSON(input: any): any {
  return typeof input === "string" && input.includes("{")
    ? JSON.parse(input)
    : JSON.parse(JSON.stringify(input));
}
