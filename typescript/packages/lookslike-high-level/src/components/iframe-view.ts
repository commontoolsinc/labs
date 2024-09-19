import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { Cell } from "@commontools/common-runner";

@customElement("common-iframe")
export class CommonIframe extends LitElement {
  @property({ type: String }) src = "";
  // HACK: The UI framework already translates the top level cell into updated
  // properties, but we want to only have to deal with one type of listening, so
  // we'll add a an extra level of indirection with the "context" property.
  @property({ type: Object }) context?: { context: Cell<any> };

  private iframeElement: HTMLIFrameElement | null = null;

  override firstUpdated() {
    this.iframeElement = this.shadowRoot?.querySelector("iframe") || null;
    window.addEventListener("message", this.handleMessage.bind(this));
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("message", this.handleMessage.bind(this));
  }

  handleMessage(event: MessageEvent) {
    console.log("Received message", event);
    if (event.source === this.iframeElement?.contentWindow) {
      const { type, key, data } = event.data;
      if (typeof key !== "string") {
        console.error("Invalid key type. Expected string.");
        return;
      }
      console.log(
        { type, key, data },
        this.context,
        typeof this.context?.context.get === "function" ? "cell" : "not cell"
      );
      if (type === "read" && this.context) {
        const value = this.context.context.getAsProxy([key]);
        // TODO: This might cause infinite loops, since the data can be a graph.
        const copy = JSON.parse(JSON.stringify(value));
        console.log("readResponse", key, value);
        this.iframeElement?.contentWindow?.postMessage(
          { type: "readResponse", key, data: copy },
          "*"
        );
      } else if (type === "write" && this.context) {
        this.context.context.getAsProxy()[key] = data;
      }
    }
  }

  override render() {
    return html`
      <iframe
        sandbox="allow-scripts"
        .srcdoc=${this.src}
        height="512px"
        width="100%"
        @load=${() => {
          if (this.iframeElement?.contentWindow) {
            this.iframeElement.contentWindow.postMessage({ type: "init" }, "*");
          }
        }}
      ></iframe>
    `;
  }
}
