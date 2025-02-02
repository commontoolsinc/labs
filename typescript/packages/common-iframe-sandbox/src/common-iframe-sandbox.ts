import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Ref, createRef, ref } from "lit/directives/ref.js";
import * as IPC from "./ipc.js";
import { getIframeContextHandler } from "./context.js";
import OuterFrame from "./outer-frame.js";

// TODO this should probably be randomly generated
let FRAME_IDS = 0;

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
  private frameId: number = ++FRAME_IDS;
  private initialized: boolean = false;
  private subscriptions: Map<string, any> = new Map();

  private onMessage = (event: MessageEvent) => {
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

    if (!IPC.isIPCGuestMessage(event.data)) {
      console.error("common-iframe-sandbox: Malformed message from guest.", event.data);
      return;
    }

    const outerMessage: IPC.IPCGuestMessage = event.data;

    switch (outerMessage.type) {
      case IPC.IPCGuestMessageType.Load: {
        this.dispatchEvent(new CustomEvent("load"));
        return;
      }
      case IPC.IPCGuestMessageType.Error: {
        console.error(`common-iframe-sandbox: Error from outer frame: ${outerMessage.data}`);
        return;
      }
      case IPC.IPCGuestMessageType.Ready: {
        if (this.initialized) {
          console.error(`common-iframe-sandbox: Already initialized. This should not occur.`);
          return;
        }
        this.initialized = true;
        this.toGuest({
          id: this.frameId,
          type: IPC.IPCHostMessageType.Init,
        });
        if (this.src) {
          this.updateInnerDoc();
        }
        return;
      }
      case IPC.IPCGuestMessageType.Passthrough: {
        const message: IPC.GuestMessage = outerMessage.data;
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
            const response: IPC.IPCHostMessage = {
              id: this.frameId,
              type: IPC.IPCHostMessageType.Passthrough,
              data: {
                type: IPC.HostMessageType.Update,
                data: [key, value],
              },
            };
            this.toGuest(response);
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
    }
  }

  private updateInnerDoc() {
    // Remove all active subscriptions when navigating
    // to a new document.
    const IframeHandler = getIframeContextHandler();
    if (IframeHandler != null) {
      for (const [_, receipt] of this.subscriptions) {
        IframeHandler.unsubscribe(this.context, receipt);
      }
      this.subscriptions.clear();
    }

    this.toGuest({
      id: this.frameId,
      type: IPC.IPCHostMessageType.LoadDocument,
      data: this.src,
    });
  }

  private notifySubscribers(key: string, value: any) {
    const response: IPC.IPCHostMessage = {
      id: this.frameId,
      type: IPC.IPCHostMessageType.Passthrough,
      data: {
        type: IPC.HostMessageType.Update,
        data: [key, value],
      }
    };
    this.toGuest(response);
  }
        
  private toGuest(event: IPC.IPCHostMessage) {
    this.iframeRef.value?.contentWindow?.postMessage(event, "*");
  }

  private boundOnMessage = this.onMessage.bind(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("message", this.boundOnMessage);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("message", this.boundOnMessage);
  }

  override willUpdate(changedProperties: PropertyValues<this>) {
    if (changedProperties.has('src') && this.initialized) {
      this.updateInnerDoc();
    }
  }

  override render() {
    return html`
      <iframe
        ${ref(this.iframeRef)}
        sandbox="allow-scripts allow-pointer-lock"
        .srcdoc=${OuterFrame}
        height="100%"
        width="100%"
        style="border: none;"
      ></iframe>
    `;
  }
}