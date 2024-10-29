import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import {
  RendererCell,
  addAction,
  removeAction,
  type Action,
  type ReactivityLog,
} from "@commontools/common-runner";
import { Ref, createRef, ref } from "lit/directives/ref.js";

@customElement("common-iframe")
export class CommonIframe extends LitElement {
  @property({ type: String }) src = "";
  // HACK: The UI framework already translates the top level cell into updated
  // properties, but we want to only have to deal with one type of listening, so
  // we'll add a an extra level of indirection with the "context" property.
  @property({ type: Object }) context?: RendererCell<any> | any;

  @state() private errorDetails: {
    message: string;
    source: string;
    lineno: number;
    colno: number;
    stacktrace: string;
  } | null = null;

  private iframeRef: Ref<HTMLIFrameElement> = createRef();

  private subscriptions: Map<string, Action[]> = new Map();

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
    console.log("Received message", event);
    if (event.data?.source == "react-devtools-content-script") {
      console.log("ignore react devtools");
      return;
    }

    if (event.source === this.iframeRef.value?.contentWindow) {
      const { type, key, value } = event.data;

      if (type === "error") {
        const { message, source, lineno, colno, stacktrace } = value;
        this.errorDetails = { message, source, lineno, colno, stacktrace };
        console.error("Error details:", {
          message,
          source,
          lineno,
          colno,
          stacktrace,
          error: value.error
            ? value.error.stack || value.error.toString()
            : null,
        });
      }

      if (typeof key !== "string") {
        console.error("Invalid key type. Expected string.");
        return;
      }
      if (type === "read" && this.context) {
        const value = this.context?.getAsQueryResult
          ? this.context?.getAsQueryResult([key])
          : this.context?.[key];
        // TODO: This might cause infinite loops, since the data can be a graph.
        console.log("readResponse", key, value);
        const copy =
          typeof value === "string" && value.includes("{")
            ? JSON.parse(value)
            : JSON.parse(JSON.stringify(value));
        this.iframeRef.value?.contentWindow?.postMessage(
          { type: "readResponse", key, value: copy },
          "*"
        );
      } else if (type === "write" && this.context) {
        const updated =
          typeof value === "string" && value.includes("{")
            ? JSON.parse(value)
            : JSON.parse(JSON.stringify(value));
        console.log("write", key, updated);
        this.context.getAsQueryResult()[key] = updated;
      } else if (type === "subscribe" && this.context) {
        console.log("subscribing", key, this.context);

        const action: Action = (log: ReactivityLog) =>
          this.notifySubscribers(
            key,
            this.context.getAsQueryResult([key], log)
          );

        addAction(action);
        if (!this.subscriptions.has(key)) this.subscriptions.set(key, [action]);
        else this.subscriptions.get(key)!.push(action);
      } else if (type === "unsubscribe" && this.context) {
        if (this.subscriptions && this.subscriptions.has(key)) {
          const actions = this.subscriptions.get(key);
          if (actions && actions.length) removeAction(actions.pop()!);
        }
      }
    }
  };

  private notifySubscribers(key: string, value: any) {
    console.log("notifySubscribers", key, value);
    // TODO: This might cause infinite loops, since the data can be a graph.
    const copy =
      value !== undefined ? JSON.parse(JSON.stringify(value)) : undefined;
    this.iframeRef.value?.contentWindow?.postMessage(
      { type: "update", key, value: copy },
      "*"
    );
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
    console.log("iframe loaded");
    this.iframeRef.value?.contentWindow?.postMessage({ type: "init" }, "*");
    this.dispatchEvent(new CustomEvent("loaded"));
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
                <p><strong>Message:</strong> ${this.errorDetails.message}</p>
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
