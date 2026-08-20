import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { createRef, Ref, ref } from "lit/directives/ref.js";
import * as IPC from "./ipc.ts";
import { getIframeContextHandler, Receipt } from "./context.ts";
import OuterFrame from "./outer-frame.ts";

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

  #src = "";

  /** The host's end of the channel to the current guest, while there is one. */
  private guestPort: MessagePort | undefined;
  private iframeRef: Ref<HTMLIFrameElement> = createRef();
  private initialized: boolean = false;
  private subscriptions: Map<string, Receipt> = new Map();

  /**
   * Handles the outer frame reporting itself ready, which it does on its own
   * load. That is once for an element that stays where it is, and again each
   * time the frame reloads -- which detaching the element and reattaching it
   * does. The guest documents in between are each announced by their own load
   * rather than by this.
   *
   * Whatever the previous frame held went with it, so this lets go of that
   * guest and loads `src` into the new frame. With no `src`, the next
   * assignment to one does the loading.
   */
  private onOuterReady() {
    this.initialized = true;
    this.releaseGuest();
    if (this.src) {
      this.loadInnerDoc();
    }
  }

  /**
   * Gives the newly loaded guest one end of a fresh channel and takes the
   * other. Each document is its own realm, so each gets a port of its own, and
   * no earlier one is left open behind it.
   */
  private openGuestPort() {
    this.closeGuestPort();

    // The guest is the inner frame, which is a frame of the outer one. A
    // cross-origin frame is unreachable for anything but this: indexed access
    // and `postMessage`, which is what a transfer rides.
    const guestWindow = this.iframeRef.value?.contentWindow?.frames[0];
    if (!guestWindow) {
      console.error("common-iframe-sandbox: No guest frame to open a port to.");
      return;
    }

    const channel = new MessageChannel();
    this.guestPort = channel.port1;
    channel.port1.onmessage = this.onGuestPortMessage;
    channel.port1.start();
    guestWindow.postMessage(IPC.GUEST_PORT_HANDOFF, "*", [channel.port2]);
  }

  /**
   * Closes the port to the current guest, if there is one. What the guest sends
   * afterwards reaches nothing, which is the point: the guest on the other end
   * of a closed port is one this element is done with.
   */
  private closeGuestPort() {
    this.guestPort?.close();
    this.guestPort = undefined;
  }

  /**
   * Handles a message on the port to the guest. A detached element ignores
   * one: the guest may have sent it before the element left the document, and
   * a write reaching the context handler from outside the document's lifetime
   * is not this element's to make.
   */
  private onGuestPortMessage = (event: MessageEvent) => {
    if (!this.isConnected) {
      return;
    }
    if (!IPC.isGuestMessage(event.data)) {
      console.error(
        "common-iframe-sandbox: Malformed message from guest.",
        event.data,
      );
      return;
    }
    this.onGuestMessage(event.data);
  };

  /** Handles a message from the outer frame. */
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
        this.openGuestPort();
        this.loadState = "loaded";
        this.dispatchEvent(new CustomEvent("load"));
        return;
      }
      case IPC.IPCGuestMessageType.OuterError: {
        console.error(
          "common-iframe-sandbox: Error from outer frame:",
          outerMessage.data,
        );
        return;
      }
      case IPC.IPCGuestMessageType.GuestError: {
        // The guest raised this outside its port, and the outer frame passed
        // it along without reading it, so this is the first look anything has
        // had at it.
        const raised = outerMessage.data;
        if (
          IPC.isGuestMessage(raised) &&
          raised.type === IPC.GuestMessageType.Error
        ) {
          this.dispatchGuestError(raised.data);
        } else {
          console.error(
            "common-iframe-sandbox: Unreadable alarm from guest.",
            raised,
          );
        }
        return;
      }
      case IPC.IPCGuestMessageType.Ready: {
        this.onOuterReady();
        return;
      }
    }
  };

  /**
   * Dispatches `common-iframe-error` for an error the guest raised, by either
   * of the routes one can arrive on.
   */
  private dispatchGuestError(
    { description, source, lineno, colno, stacktrace }: IPC.GuestError,
  ) {
    this.dispatchEvent(
      new CustomEvent("common-iframe-error", {
        detail: {
          description,
          message: description,
          source,
          lineno,
          colno,
          stacktrace,
          stack: stacktrace,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Handles a message the guest sent, on whichever route carried it. */
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
        this.dispatchGuestError(message.data);
        return;
      }

      case IPC.GuestMessageType.Read: {
        const key = message.data;
        const value = IframeHandler.read(this, this.context, key);
        this.toGuest({ type: IPC.HostMessageType.Update, data: [key, value] });
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

  /**
   * Lets go of the current guest, if there is one: its subscriptions are
   * cancelled and its port is closed. Called where a guest stops being this
   * element's, which is when one is asked to be replaced and when the frame
   * holding it has gone.
   */
  private releaseGuest() {
    this.closeGuestPort();

    const IframeHandler = getIframeContextHandler();
    if (IframeHandler != null) {
      for (const [_, receipt] of this.subscriptions) {
        IframeHandler.unsubscribe(this, this.context, receipt);
      }
      this.subscriptions.clear();
    }
  }

  /**
   * Asks the outer frame to load `src`, letting go of the guest being replaced
   * first, so that guest cannot write over the interval in which it is still
   * running and already superseded.
   */
  private loadInnerDoc() {
    this.loadState = "loading";
    this.releaseGuest();
    this.toOuterFrame({
      type: IPC.IPCHostMessageType.LoadDocument,
      data: this.src,
    });
  }

  /** Tells the guest that `key` now holds `value`. */
  private notifySubscribers(key: string, value: unknown) {
    this.toGuest({ type: IPC.HostMessageType.Update, data: [key, value] });
  }

  /** Sends `message` to the outer frame. */
  private toOuterFrame(message: IPC.IPCHostMessage) {
    this.iframeRef.value?.contentWindow?.postMessage(message, "*");
  }

  /**
   * Sends `message` to the guest. Does nothing when there is no port, which is
   * every moment outside a loaded guest's lifetime.
   */
  private toGuest(message: IPC.HostMessage) {
    this.guestPort?.postMessage(message);
  }

  /** The outer frame's message listener, as `globalThis` holds it. */
  private boundOnMessage = this.onMessage.bind(this);

  /** @inheritDoc */
  override connectedCallback() {
    super.connectedCallback();
    globalThis.addEventListener("message", this.boundOnMessage);
  }

  /** @inheritDoc */
  override disconnectedCallback() {
    super.disconnectedCallback();
    globalThis.removeEventListener("message", this.boundOnMessage);
  }

  /** @inheritDoc */
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
