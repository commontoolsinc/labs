import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Ref, createRef, ref } from "lit/directives/ref.js";
import * as IPC from "./ipc.js";
import { getIframeContextHandler } from "./context.js";
import { CSP } from "./csp.js";

// @summary A sandboxed iframe to execute arbitrary scripts.
// @tag common-iframe-sandbox
// @prop {string} src - String representation of HTML content to load within an iframe.
// @prop context - Cell context.
// @event {CustomEvent} error - An error from the iframe.
// @event {CustomEvent} load - The iframe was successfully loaded.
@customElement("common-iframe-sandbox")
export class CommonIframeSandboxElement extends LitElement {
  @property({ type: String }) src = "";
  @property({ type: Object }) context?: object;

  private iframeRef: Ref<HTMLIFrameElement> = createRef();

  private subscriptions: Map<string, any> = new Map();

  private handleMessage = (event: MessageEvent) => {
    if (event.data?.source == "react-devtools-content-script") {
      return;
    }

    if (event.source !== this.iframeRef.value?.contentWindow) {
      return;
    }

    const IframeHandler = getIframeContextHandler();
    if (IframeHandler == null) {
      console.error("common-iframe-sandbox: No iframe handler defined.");
      return;
    }

    if (!this.context) {
      console.error("common-iframe-sandbox: missing `context`.");
      return;
    }

    if (!IPC.isGuestMessage(event.data)) {
      console.error("common-iframe-sandbox: Malformed message from guest.");
      return;
    }

    const message: IPC.GuestMessage = event.data;

    switch (message.type) {
      case IPC.GuestMessageType.Error: {
        const { description, source, lineno, colno, stacktrace } = message.data;
        const error = { description, source, lineno, colno, stacktrace };
        this.dispatchEvent(new CustomEvent("error", {
          detail: error,
        }));
        return;
      }

      case IPC.GuestMessageType.Read: {
        const key = message.data;
        const value = IframeHandler.read(this.context, key);
        const response: IPC.HostMessage = {
          type: IPC.HostMessageType.Update,
          data: [key, value],
        }
        this.iframeRef.value?.contentWindow?.postMessage(response, "*");
        return;
      }

      case IPC.GuestMessageType.Write: {
        const [key, value] = message.data;
        IframeHandler.write(this.context, key, value);
        return;
      }

      case IPC.GuestMessageType.Subscribe: {
        const key = message.data;

        if (this.subscriptions.has(key)) {
          console.warn("common-iframe-sandbox: Already subscribed to `${key}`");
          return;
        }
        let receipt = IframeHandler.subscribe(this.context, key, (key, value) => this.notifySubscribers(key, value));
        this.subscriptions.set(key, receipt);
        return;
      }

      case IPC.GuestMessageType.Unsubscribe: {
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
    const response: IPC.HostMessage = {
      type: IPC.HostMessageType.Update,
      data: [key, value],
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
    `;
  }
}