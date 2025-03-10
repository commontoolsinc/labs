import { html, LitElement, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { createRef, Ref, ref } from "lit/directives/ref.js";
import * as IPC from "./ipc.ts";
import { getIframeContextHandler } from "./context.ts";
import OuterFrame from "./outer-frame.ts";

let FRAME_IDS = 0;

// @summary A sandboxed iframe to execute arbitrary scripts.
// @tag common-iframe-sandbox
// @prop {string} src - String representation of HTML content to load within an iframe.
// @prop context - Cell context.
// @event {CustomEvent} error - An error from the iframe.
// @event {CustomEvent} load - The iframe was successfully loaded.
export class CommonIframeSandboxElement extends LitElement {
  static override properties = {
    src: { type: String, attribute: false },
    context: { type: Object, attribute: false },
  };
  declare src: string;
  declare context?: object;

  constructor() {
    super();
    this.src = "";
    this.context = undefined;
  }

  // Static id for this component for its lifetime.
  private frameId: number = ++FRAME_IDS;
  // An incrementing id for each new page load to disambiguate
  // requests between inner page loads.
  private instanceId: number = 0;
  private iframeRef: Ref<HTMLIFrameElement> = createRef();
  private initialized: boolean = false;
  private subscriptions: Map<string, any> = new Map();

  // Called when the outer frame emits
  // `IPCGuestMessageType.Ready`, only once, upon
  // the initial render.
  private onOuterReady() {
    if (this.initialized) {
      throw new Error(`common-iframe-sandbox: Already initialized.`);
    }
    this.initialized = true;
    this.toGuest({
      id: this.frameId,
      type: IPC.IPCHostMessageType.Init,
    });
    if (this.src) {
      this.loadInnerDoc();
    }
  }

  // Message from the outer frame.
  private onMessage = (event: MessageEvent) => {
    if (event.source !== this.iframeRef.value?.contentWindow) {
      return;
    }

    if (!IPC.isIPCGuestMessage(event.data)) {
      console.error(
        "common-iframe-sandbox: Malformed message from guest.",
        event.data,
      );
      return;
    }

    const outerMessage: IPC.IPCGuestMessage = event.data;

    switch (outerMessage.type) {
      case IPC.IPCGuestMessageType.Load: {
        this.dispatchEvent(new CustomEvent("load"));
        return;
      }
      case IPC.IPCGuestMessageType.Error: {
        console.error(
          `common-iframe-sandbox: Error from outer frame: ${outerMessage.data}`,
        );
        return;
      }
      case IPC.IPCGuestMessageType.Ready: {
        this.onOuterReady();
        return;
      }
      case IPC.IPCGuestMessageType.Passthrough: {
        this.onGuestMessage(outerMessage.data);
        return;
      }
    }
  };

  // Message from the inner frame.
  private onGuestMessage(message: IPC.GuestMessage) {
    const IframeHandler = getIframeContextHandler();
    if (IframeHandler == null) {
      console.error("common-iframe-sandbox: No iframe handler defined.");
      return;
    }

    if (!this.context) {
      console.warn("common-iframe-sandbox: missing `context`.");
      return;
    }

    switch (message.type) {
      case IPC.GuestMessageType.Error: {
        const { description, source, lineno, colno, stacktrace } = message.data;
        const error = {
          description,
          message: description,
          source,
          lineno,
          colno,
          stacktrace,
          stack: stacktrace,
        };

        this.dispatchEvent(
          new CustomEvent("common-iframe-error", {
            detail: error,
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }

      case IPC.GuestMessageType.Read: {
        const key = message.data;
        const value = IframeHandler.read(this.context, key);
        this.toGuest({
          id: this.frameId,
          type: IPC.IPCHostMessageType.Passthrough,
          data: {
            type: IPC.HostMessageType.Update,
            data: [key, value],
          },
        });
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
        const receipt = IframeHandler.subscribe(
          this.context,
          key,
          (key, value) => this.notifySubscribers(key, value),
        );
        this.subscriptions.set(key, receipt);
        return;
      }

      case IPC.GuestMessageType.Unsubscribe: {
        const key = message.data;
        const receipt = this.subscriptions.get(key);
        if (!receipt) {
          return;
        }
        IframeHandler.unsubscribe(this.context, receipt);
        this.subscriptions.delete(key);
        return;
      }

      case IPC.GuestMessageType.LLMRequest: {
        const payload = message.data;
        const promise = IframeHandler.onLLMRequest(this.context, payload);
        const instanceId = this.instanceId;
        promise.then((result: object) => {
          if (this.instanceId !== instanceId) {
            // Inner frame was reloaded. This LLM response was
            // from a previous page. Abort.
            return;
          }
          this.toGuest({
            id: this.frameId,
            type: IPC.IPCHostMessageType.Passthrough,
            data: {
              type: IPC.HostMessageType.LLMResponse,
              request: payload,
              data: result,
              error: undefined,
            },
          });
        }, (error: any) => {
          if (this.instanceId !== instanceId) {
            // Inner frame was reloaded. This LLM response was
            // from a previous page. Abort.
            return;
          }
          this.toGuest({
            id: this.frameId,
            type: IPC.IPCHostMessageType.Passthrough,
            data: {
              type: IPC.HostMessageType.LLMResponse,
              request: payload,
              data: null,
              error,
            },
          });
        });
        return;
      }
    }
  }

  private loadInnerDoc() {
    // Remove all active subscriptions when navigating
    // to a new document.
    const IframeHandler = getIframeContextHandler();
    if (IframeHandler != null) {
      for (const [_, receipt] of this.subscriptions) {
        IframeHandler.unsubscribe(this.context, receipt);
      }
      this.subscriptions.clear();
    }

    ++this.instanceId;

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
      },
    };
    this.toGuest(response);
  }

  private toGuest(event: IPC.IPCHostMessage) {
    this.iframeRef.value?.contentWindow?.postMessage(event, "*");
  }

  private boundOnMessage = this.onMessage.bind(this);

  override connectedCallback() {
    super.connectedCallback();
    globalThis.addEventListener("message", this.boundOnMessage);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    globalThis.removeEventListener("message", this.boundOnMessage);
  }

  override willUpdate(changedProperties: PropertyValues<this>) {
    if (changedProperties.has("src") && this.initialized) {
      this.loadInnerDoc();
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

customElements.define("common-iframe-sandbox", CommonIframeSandboxElement);
