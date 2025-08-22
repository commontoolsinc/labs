import { css, html, LitElement, PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { createRef, Ref, ref } from "lit/directives/ref.js";
import * as IPC from "./ipc.ts";
import { getIframeContextHandler, Receipt } from "./context.ts";
import OuterFrame from "./outer-frame.ts";
import {
  HealthCheck,
  HealthCheckAbort,
  HealthCheckTimeout,
} from "./health-check.ts";
import { sleep } from "@commontools/utils/sleep";

let FRAME_IDS = 0;

// Currently, recipes are expected to handle heavy processing,
// and backgrounding the tab affects the timers. In the future,
// we could handle this more dynamically.
// As this will need to be influenced by heuristics, and currently,
// usually wanting to wait for a recipe to finish processing,
// we will not "crash tabs" yet until things settle.
const HEALTH_CHECKING_ENABLED = false;

// Delay, in ms, after starting page load before
// health checks result in freezing content.
const HEALTH_CHECK_LOAD_DELAY = 5000;
// The time frame, in ms, that content must respond to within
// in order to pass the health check.

// Should be rather low, but currently it's too likely for a
// charm to spend a lot of time processing.
const HEALTH_CHECK_TIMEOUT = 3000;

type CommonIframeLoadState = "" | "loading" | "loaded";

// @summary A sandboxed iframe to execute arbitrary scripts.
// @tag common-iframe-sandbox
// @prop {string} src - String representation of HTML content to load within an iframe.
// @prop context - Cell context.
// @event {CustomEvent} error - An error from the iframe.
// @event {CustomEvent} load - The iframe was successfully loaded.
export class CommonIframeSandboxElement extends LitElement {
  @property()
  src = "";

  @property()
  context?: object;

  @property()
  crashed = false;

  @property({ attribute: "load-state", reflect: true })
  loadState: CommonIframeLoadState = "";

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #ddd;
    }
    #crash-message {
      width: 50%;
      margin: 20px auto;
      display: flex;
      flex-direction: column;
      text-align: center;
    }
    #crash-message > * {
      flex: 1;
    }
    #crash-message button {
      font-size: 20px;
      background-color: white;
      border: 1px solid black;
    }
  `;

  // Static id for this component for its lifetime.
  private frameId: number = ++FRAME_IDS;
  // An incrementing id for each new page load to disambiguate
  // requests between inner page loads.
  private instanceId: number = 0;
  private iframeRef: Ref<HTMLIFrameElement> = createRef();
  private initialized: boolean = false;
  private subscriptions: Map<string, Receipt> = new Map();
  // Timestamp of when the inner frame was loaded.
  private pageLoadTimestamp: number = 0;

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
        this.pageLoadTimestamp = performance.now();
        if (this.contentSupportsHealthCheck()) {
          this.requestHealthCheck();
        }
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
        this.onGuestMessage(outerMessage.data);
        return;
      }
    }
  };

  // Message from the inner frame.
  private async onGuestMessage(message: IPC.GuestMessage) {
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
        IframeHandler.write(this, this.context, key, value);
        return;
      }

      case IPC.GuestMessageType.Subscribe: {
        const keys = typeof message.data === "string"
          ? [message.data]
          : message.data;

        // TODO(seefeld): Remove this and make this default true on 3/31/2025 or
        // whenever we delete all charms anyway. This is just a stopgap to not
        // break existing charms.
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
          const receipt = this.subscriptions.get(key);
          if (!receipt) {
            continue;
          }
          IframeHandler.unsubscribe(this, this.context, receipt);
          this.subscriptions.delete(key);
        }
        return;
      }

      case IPC.GuestMessageType.LLMRequest: {
        const payload = message.data;
        const promise = IframeHandler.onLLMRequest(this, this.context, payload);
        const instanceId = this.instanceId;
        promise.then((result: object) => {
          if (!this.ensureSameDocument(instanceId)) {
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
        }, (error: unknown) => {
          if (!this.ensureSameDocument(instanceId)) {
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

      case IPC.GuestMessageType.WebpageRequest: {
        const payload = message.data;
        const instanceId = this.instanceId;

        let result, error;
        try {
          result = await IframeHandler.onReadWebpageRequest(
            this,
            this.context,
            payload,
          );
        } catch (e) {
          error = e;
        }

        if (!this.ensureSameDocument(instanceId)) {
          return;
        }

        this.toGuest({
          id: this.frameId,
          type: IPC.IPCHostMessageType.Passthrough,
          data: {
            type: IPC.HostMessageType.ReadWebpageResponse,
            request: payload,
            data: result || null,
            error,
          },
        });
        return;
      }

      case IPC.GuestMessageType.Perform: {
        const instanceId = this.instanceId;
        IframeHandler.onPerform(this, this.context, message.data).then(
          (result) => {
            if (!this.ensureSameDocument(instanceId)) {
              return;
            }

            this.toGuest({
              id: this.frameId,
              type: IPC.IPCHostMessageType.Passthrough,
              data: {
                type: IPC.HostMessageType.Effect,
                id: message.data.id,
                result,
              },
            });
          },
        );
        return;
      }
      case IPC.GuestMessageType.Pong: {
        if (!this.healthCheck) {
          return;
        }

        this.healthCheck.tryFulfill(message.data);
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

    ++this.instanceId;

    this.toGuest({
      id: this.frameId,
      type: IPC.IPCHostMessageType.LoadDocument,
      data: this.src,
    });
  }

  private healthCheck?: HealthCheck;

  private async requestHealthCheck() {
    if (!HEALTH_CHECKING_ENABLED) {
      return;
    }

    if (this.healthCheck) {
      this.healthCheck.abort();
      this.healthCheck = undefined;
    }

    const instanceId = this.instanceId;

    const startJitter = performance.now();
    // Wait between 100-500ms to schedule
    // the next health check to avoid janky cycles.
    const jitter = 100 + (Math.random() * 400);
    await sleep(jitter);

    // If the jitter took longer than expected by HEALTH_CHECK_TIMEOUT,
    // the inner frame could have blocked the main thread while waiting
    // on jitter. We see this in Firefox.
    // Using iframes with different domains should run this in a separate thread,
    // but as we're using srcdoc iframe, it's likely to always block main thread here.
    if ((performance.now() - startJitter) > jitter + HEALTH_CHECK_TIMEOUT) {
      this.onHealthCheckFailure(new HealthCheckTimeout());
    }

    if (!this.ensureSameDocument(instanceId)) {
      return;
    }

    this.healthCheck = new HealthCheck(HEALTH_CHECK_TIMEOUT);
    this.healthCheck.result().then(
      () => this.requestHealthCheck(),
      (e) => this.onHealthCheckFailure(e),
    );

    this.toGuest({
      id: this.frameId,
      type: IPC.IPCHostMessageType.Passthrough,
      data: {
        type: IPC.HostMessageType.Ping,
        data: this.healthCheck.nonce,
      },
    });
  }

  private onHealthCheckFailure(e: Error) {
    // Ignore aborted health checks.
    if (e.name === HealthCheckAbort.prototype.name) {
      return;
    }

    // Ignore if health checks fail near page load -- let
    // things settle a bit, and queue up another check.
    if (
      (performance.now() - this.pageLoadTimestamp) < HEALTH_CHECK_LOAD_DELAY
    ) {
      this.requestHealthCheck();
      return;
    }

    this.crashed = true;
    this.initialized = false;
  }

  // This is to be called with the `instanceId` of a request
  // after an async boundary to ensure the inner frame
  // was not reloaded.
  private ensureSameDocument(instanceId: number): boolean {
    return this.instanceId === instanceId;
  }

  private notifySubscribers(key: string, value: unknown) {
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

  private onCrashReload() {
    this.crashed = false;
  }

  private toGuest(event: IPC.IPCHostMessage) {
    this.iframeRef.value?.contentWindow?.postMessage(event, "*");
  }

  // In lieu of versioning, check the content to see
  // if there is a ping handler; otherwise, older charms
  // will always fail health check, as it cannot respond
  // to the ping.
  private contentSupportsHealthCheck() {
    return /\<PING-HANDLER\>/.test(this.src);
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
    if (this.crashed) {
      return html`
        <div id="crash-message">
          <div class="message">🤨 Charm crashed! 🤨</div>
          <button @click="${this.onCrashReload}">Reload</button>
        </div>
      `;
    }
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
