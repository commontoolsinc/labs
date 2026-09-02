import { css, html, LitElement, type PropertyValues } from "lit";
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
  }

  get bridge(): FabricBridge | undefined {
    return this.#bridge;
  }

  @property({ attribute: false })
  set bridge(value: FabricBridge | undefined) {
    const previousValue = this.#bridge;
    this.#bridge = value;
    this.requestUpdate("bridge", previousValue);
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

  /**
   * The capability sessions on offer to the loaded guest, in offer order. One
   * is offered per load report, and a load report cannot be matched to a
   * document -- the inner frame's initial `about:blank` navigation can
   * complete after a document was asked for, so one asked-for document can
   * yield two reports. Which offer the guest holds is settled by use: a
   * session's first request retires every session offered before it.
   *
   * Two entries is the most this holds. The guest takes the first port to
   * reach a document of its that has none, so the session it holds is the
   * earliest one still here, and everything offered after that one was
   * refused.
   */
  #guestSessions: FabricBridgeHost[] = [];

  /**
   * The frame this element renders, held so the guest can be reached through
   * it. TypeScript-private rather than `#`, as `readyWindow` and
   * `onOuterReady` also are, because `test/iframe.browser.test.ts` reaches for
   * all three: it asserts the outer-ready refusal where the refusal is made,
   * and a frame reports itself ready exactly once, from a window nothing
   * outside this element can speak for.
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
   * Offers the loaded guest one end of a fresh channel and takes the other.
   * Each document is its own realm, so each gets a port of its own. A session
   * already on offer stays as it is: whether this offer reaches a new document
   * or one already holding a port -- which refuses it -- is settled by which
   * session the guest's requests arrive on, not here.
   */
  #openGuestPort() {
    // The guest is the inner frame, which is a frame of the outer one. A
    // cross-origin frame is unreachable for anything but this: indexed access
    // and `postMessage`, which is what a transfer rides.
    const guestWindow = this.iframeRef.value?.contentWindow?.frames[0];
    if (!guestWindow) {
      console.error("common-iframe-sandbox: No guest frame to open a port to.");
      return;
    }

    // A guest can renavigate its own frame, and each navigation reports a
    // load, so what is kept here has to be bounded by something other than
    // the guest's restraint. Two are kept: the first, which is the one a guest
    // that has held a port since before any of this took, and the newest,
    // which is the only other one still reachable. Dropping what was newest
    // costs a guest that took that offer, has never spoken on it, and is still
    // there after a further load report -- which is a document driving
    // navigations while staying silent about the port it holds.
    for (const superseded of this.#guestSessions.splice(1)) {
      superseded.disconnect();
    }

    const channel = new MessageChannel();
    this.#guestSessions.push(
      new FabricBridgeHost(
        this.bridge ?? { resources: {} },
        channel.port1,
        (session) => this.#retireSessionsBefore(session),
      ),
    );
    guestWindow.postMessage(IPC.GUEST_PORT_ORDERED, "*");
    guestWindow.postMessage(IPC.GUEST_PORT_HANDOFF, "*", [channel.port2]);
  }

  /**
   * Retires every session offered before `session`, which has shown the first
   * request of its port. The guest holds one port, so a request on this
   * session says every earlier offer went to a document that is gone or was
   * refused; either way those sessions serve nobody, and closing them is what
   * cancels a gone document's subscriptions. Later offers are left alone: a
   * session is never unseated by an earlier one.
   */
  #retireSessionsBefore(session: FabricBridgeHost) {
    const index = this.#guestSessions.indexOf(session);
    if (index <= 0) return;
    for (const retired of this.#guestSessions.splice(0, index)) {
      retired.disconnect();
    }
  }

  /**
   * Closes every session on offer. What the guest sends afterwards reaches
   * nothing, which is the point: the guest on the other end of a closed port
   * is one this element is done with.
   */
  #closeGuestPort() {
    for (const session of this.#guestSessions) {
      session.disconnect();
    }
    this.#guestSessions = [];
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
        if (IPC.isGuestFlush(raised)) {
          // Everything the relay carried ahead of this marker has been
          // handled, which is what the acknowledgement asserts. A marker
          // cannot say which session its guest holds, so every session on
          // offer carries the answer; the nonce sees to it that only the
          // guest that posted this marker acts on one.
          for (const session of this.#guestSessions) {
            session.acknowledgeFlush(raised.nonce);
          }
        } else if (IPC.isGuestAlarm(raised)) {
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

  /**
   * Reloads on a change to `src` or `bridge`, once the frame is ready; until
   * then `onOuterReady` does the first load. Reacting here rather than in the
   * setters folds a batch of changes into one load: assigning both properties
   * asks for one document, carrying both new values, rather than reloading
   * the old document under the new bridge on the way.
   */
  protected override updated(changed: PropertyValues) {
    super.updated(changed);
    if (!this.readyWindow) return;
    if (changed.has("src") || (changed.has("bridge") && this.src)) {
      this.#loadInnerDoc();
    }
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
