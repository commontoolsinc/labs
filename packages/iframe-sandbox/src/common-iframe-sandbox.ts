import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { createRef, Ref, ref } from "lit/directives/ref.js";
import { type FabricBridge, FabricBridgeHost } from "./bridge.ts";
import * as IPC from "./ipc.ts";
import OuterFrame from "./outer-frame.ts";

type CommonIframeLoadState = "" | "loading" | "loaded";

// @summary A sandboxed iframe to execute arbitrary scripts.
// @tag common-iframe-sandbox
// @prop {string} src - String representation of HTML content to load within an iframe.
// @prop bridge - Explicit resources made available to the guest.
// @event {CustomEvent} common-iframe-error - An error from the iframe.
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
    if (this.readyWindow && value !== previousValue) {
      this.#loadInnerDoc();
    }
  }

  get bridge(): FabricBridge | undefined {
    return this.#bridge;
  }

  @property({ attribute: false })
  set bridge(value: FabricBridge | undefined) {
    const previousValue = this.#bridge;
    this.#bridge = value;
    this.requestUpdate("bridge", previousValue);
    if (this.readyWindow && value !== previousValue && this.src) {
      this.#loadInnerDoc();
    }
  }

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
  #bridge: FabricBridge | undefined;

  /** The capability session belonging to the currently loaded guest. */
  #guestHost: FabricBridgeHost | undefined;

  /**
   * The frame this element renders, held so the guest can be reached through
   * it. TypeScript-private rather than `#`, as `readyWindow` and
   * `onOuterReady` also are, because `test/iframe.browser.test.ts` reaches for all
   * three: it asserts the outer-ready refusal where the refusal is made, and
   * a frame reports itself ready exactly once, from a window nothing outside
   * this element can speak for.
   */
  private iframeRef: Ref<HTMLIFrameElement> = createRef();

  /**
   * The outer-frame window whose `ready` this element last acted on, once one
   * has. Its identity is what tells a frame that has been replaced from the
   * one already in hand: detaching the element discards the frame's browsing
   * context, so the frame reattaching brings is a different window.
   */
  private readyWindow: Window | undefined;

  /**
   * Handles the outer frame reporting itself ready, which it does on its own
   * load. That is once for an element that stays where it is, and again each
   * time the frame reloads -- which detaching the element and reattaching it
   * across a turn of the event loop does, a move within one leaving the frame
   * alone. The guest documents in between are each announced by their own load
   * rather than by this.
   *
   * Whatever the previous frame held went with it, so this lets go of that
   * guest and loads `src` into the new frame. With no `src` there is nothing
   * to load and nothing loaded, which is what the load state then says; the
   * next assignment to one does the loading.
   *
   * `source` is the window that reported it, and a second report from the one
   * already in hand is refused: a frame says this once, so hearing it twice
   * from the same window is this element's model of the frame's lifetime being
   * wrong rather than a frame having been replaced.
   */
  private onOuterReady(source: Window) {
    if (source === this.readyWindow) {
      throw new Error(`common-iframe-sandbox: Already initialized.`);
    }
    this.readyWindow = source;
    this.#releaseGuest();
    if (this.src) {
      this.#loadInnerDoc();
    } else {
      this.loadState = "";
    }
  }

  /**
   * Gives the newly loaded guest one end of a fresh channel and takes the
   * other. Each document is its own realm, so each gets a port of its own, and
   * no earlier one is left open behind it.
   */
  #openGuestPort() {
    this.#closeGuestPort();

    // The guest is the inner frame, which is a frame of the outer one. A
    // cross-origin frame is unreachable for anything but this: indexed access
    // and `postMessage`, which is what a transfer rides.
    const guestWindow = this.iframeRef.value?.contentWindow?.frames[0];
    if (!guestWindow) {
      console.error("common-iframe-sandbox: No guest frame to open a port to.");
      return;
    }

    const channel = new MessageChannel();
    this.#guestHost = new FabricBridgeHost(
      this.bridge ?? { resources: {} },
      channel.port1,
    );
    guestWindow.postMessage(IPC.GUEST_PORT_HANDOFF, "*", [channel.port2]);
  }

  /**
   * Closes the port to the current guest, if there is one. What the guest sends
   * afterwards reaches nothing, which is the point: the guest on the other end
   * of a closed port is one this element is done with.
   */
  #closeGuestPort() {
    this.#guestHost?.disconnect();
    this.#guestHost = undefined;
  }

  /** Handles a message from the outer frame. */
  #onMessage = (event: MessageEvent) => {
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
        this.#openGuestPort();
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
        if (IPC.isGuestAlarm(raised)) {
          this.#dispatchGuestError(raised.data);
        } else {
          console.error(
            "common-iframe-sandbox: Unreadable alarm from guest.",
            raised,
          );
        }
        return;
      }
      case IPC.IPCGuestMessageType.Ready: {
        this.onOuterReady(event.source as Window);
        return;
      }
    }
  };

  /**
   * Dispatches `common-iframe-error` for an error the guest raised, by either
   * of the routes one can arrive on.
   */
  #dispatchGuestError(
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

  /**
   * Lets go of the current guest, if there is one: its subscriptions are
   * cancelled, each against the context it was taken out against, and its port
   * is closed. Called where a guest stops being this
   * element's, which is when one is asked to be replaced and when the frame
   * holding it has gone.
   */
  #releaseGuest() {
    this.#closeGuestPort();
  }

  /**
   * Asks the outer frame to load `src`, letting go of the guest being replaced
   * before asking rather than once the replacement arrives. What that guest
   * sends over the interval between the two reaches a closed port, which is
   * the whole of what this end can promise about a document still running in a
   * frame it has asked to be rid of.
   */
  #loadInnerDoc() {
    this.loadState = "loading";
    this.#releaseGuest();
    this.#toOuterFrame({
      type: IPC.IPCHostMessageType.LoadDocument,
      data: this.src,
    });
  }

  /** Sends `message` to the outer frame. */
  #toOuterFrame(message: IPC.IPCHostMessage) {
    this.iframeRef.value?.contentWindow?.postMessage(message, "*");
  }

  /** The outer frame's message listener, as `globalThis` holds it. */
  #boundOnMessage = this.#onMessage.bind(this);

  /** @inheritDoc */
  override connectedCallback() {
    super.connectedCallback();
    globalThis.addEventListener("message", this.#boundOnMessage);
  }

  /** @inheritDoc */
  override disconnectedCallback() {
    super.disconnectedCallback();
    globalThis.removeEventListener("message", this.#boundOnMessage);
    queueMicrotask(() => {
      if (!this.isConnected) this.#releaseGuest();
    });
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
