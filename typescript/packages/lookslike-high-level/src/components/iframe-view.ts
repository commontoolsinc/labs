import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import {
  Cell,
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
  @property({ type: Object }) context?: Cell<any> | any;

  private iframeRef: Ref<HTMLIFrameElement> = createRef();

  private subscriptions: Map<string, Action[]> = new Map();

  private handleMessage = (event: MessageEvent) => {
    console.log("Received message", event);
    if (event.source === this.iframeRef.value?.contentWindow) {
      const { type, key, value } = event.data;
      if (typeof key !== "string") {
        console.error("Invalid key type. Expected string.");
        return;
      }
      if (type === "read" && this.context) {
        const value = this.context?.getAsProxy
          ? this.context?.getAsProxy([key])
          : this.context?.[key];
        // TODO: This might cause infinite loops, since the data can be a graph.
        const copy =
          value !== undefined ? JSON.parse(JSON.stringify(value)) : undefined;
        console.log("readResponse", key, value);
        this.iframeRef.value?.contentWindow?.postMessage(
          { type: "readResponse", key, value: copy },
          "*"
        );
      } else if (type === "write" && this.context) {
        this.context.getAsProxy()[key] = value;
      } else if (type === "subscribe" && this.context) {
        console.log("subscribing", key, this.context);

        const action: Action = (log: ReactivityLog) =>
          this.notifySubscribers(key, this.context.getAsProxy([key], log));

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

  override render() {
    return html`
      <iframe
        ${ref(this.iframeRef)}
        sandbox="allow-scripts"
        .srcdoc=${this.src}
        height="512px"
        width="100%"
        @load=${this.iframeRef.value?.contentWindow?.postMessage(
          { type: "init" },
          "*"
        )}
      ></iframe>
    `;
  }
}
