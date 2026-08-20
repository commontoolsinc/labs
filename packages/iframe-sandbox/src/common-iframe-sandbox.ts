import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { createRef, Ref, ref } from "lit/directives/ref.js";
import * as IPC from "./ipc.ts";
import { getIframeContextHandler, Receipt } from "./context.ts";
import OuterFrame from "./outer-frame.ts";

let FRAME_IDS = 0;

type CommonIframeLoadState = "" | "loading" | "loaded";

// @summary A sandboxed iframe to execute arbitrary scripts.
// @tag common-iframe-sandbox
// @prop {string} src - String representation of HTML content to load within an iframe.
// @prop context - Cell context.
// @event {CustomEvent} error - An error from the iframe.
// @event {CustomEvent} load - The iframe was successfully loaded.
export class CommonIframeSandboxElement extends LitElement {
  get src() {
    return this.#src;
  }

  @property()
  set src(value: string) {
    const previousValue = this.#src;
    this.#src = value;
    this.requestUpdate("src", previousValue);
    if (this.initialized && value !== previousValue) {
      this.loadInnerDoc();
    }
  }

  @property()
  accessor context: object | undefined = undefined;

  @property({ attribute: "load-state", reflect: true })
  accessor loadState: CommonIframeLoadState = "";

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #ddd;
    }
  `;

  // Static id for this component for its lifetime.
  private frameId: number = ++FRAME_IDS;
  #src = "";
  private iframeRef: Ref<HTMLIFrameElement> = createRef();
  private initialized: boolean = false;
  private subscriptions: Map<string, Receipt> = new Map();

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
        this.loadState = "loaded";
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
        // The guest is untrusted, so this payload is a claim on two counts:
        // that it is an encoding at all, and that what it encodes is a message
        // this protocol writes. The decode settles the first -- it holds the
        // marker this build mints -- and `isGuestMessage()` the second. Either
        // refusal drops the message and leaves the frame running.
        let decoded: FabricValue;
        try {
          decoded = fabricFromRealmValue(outerMessage.data);
        } catch (error) {
          console.warn(
            `common-iframe-sandbox: undecodable guest message: ` +
              String(error),
          );
          return;
        }
        if (!IPC.isGuestMessage(decoded)) {
          console.warn("common-iframe-sandbox: malformed guest message.");
          return;
        }
        this.onGuestMessage(decoded);
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
        const value = IframeHandler.read(this, this.context, key);
        this.toGuestUpdate(key, value);
        return;
      }

      case IPC.GuestMessageType.Write: {
        const [key, value] = message.data;
        IframeHandler.write(this, this.context, key, value);
        return;
      }

      case IPC.GuestMessageType.Subscribe: {
        const keys = typeof message.data === "string"
          ? [message.data]
          : message.data;

        // TODO(seefeld): Remove this and make this default true on 3/31/2025 or
        // whenever we delete all pieces anyway. This is just a stopgap to not
        // break existing pieces.
        const doNotSendMyDataBack = Array.isArray(message.data);

        for (const key of keys) {
          if (this.subscriptions.has(key)) {
            console.warn(
              "common-iframe-sandbox: Already subscribed to `${key}`",
            );
            continue;
          }
          const receipt = IframeHandler.subscribe(
            this,
            this.context,
            key,
            (key, value) => this.notifySubscribers(key, value),
            doNotSendMyDataBack,
          );
          this.subscriptions.set(key, receipt);
        }
        return;
      }

      case IPC.GuestMessageType.Unsubscribe: {
        const keys = typeof message.data === "string"
          ? [message.data]
          : message.data;

        for (const key of keys) {
          // A receipt is opaque and may be any value the handler returns,
          // including falsy ones like `0`. Test for the entry, not the value.
          if (!this.subscriptions.has(key)) {
            continue;
          }
          const receipt = this.subscriptions.get(key);
          IframeHandler.unsubscribe(this, this.context, receipt);
          this.subscriptions.delete(key);
        }
        return;
      }
    }
  }

  private loadInnerDoc() {
    this.loadState = "loading";
    // Remove all active subscriptions when navigating
    // to a new document.
    const IframeHandler = getIframeContextHandler();
    if (IframeHandler != null) {
      for (const [_, receipt] of this.subscriptions) {
        IframeHandler.unsubscribe(this, this.context, receipt);
      }
      this.subscriptions.clear();
    }

    this.toGuest({
      id: this.frameId,
      type: IPC.IPCHostMessageType.LoadDocument,
      data: this.src,
    });
  }

  private notifySubscribers(key: string, value: FabricValue) {
    this.toGuestUpdate(key, value);
  }

  // Sends `key`'s value to the guest. The whole `HostMessage` is what the
  // encoding covers, the outer frame handing this arm's payload through
  // without reading it.
  private toGuestUpdate(key: string, value: FabricValue) {
    this.toGuest({
      id: this.frameId,
      type: IPC.IPCHostMessageType.Passthrough,
      data: realmFromFabricValue({
        type: IPC.HostMessageType.Update,
        data: [key, value],
      }),
    });
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

  override render() {
    return html`
      <iframe
        ${ref(this.iframeRef)}
        allow="clipboard-write"
        sandbox="allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox"
        .srcdoc="${OuterFrame}"
        height="100%"
        width="100%"
        style="border: none;"
      ></iframe>
    `;
  }
}

customElements.define("common-iframe-sandbox", CommonIframeSandboxElement);
