import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { Cell } from "@commontools/common-runner";
import { Ref, createRef, ref } from "lit/directives/ref.js";

@customElement("common-iframe")
export class CommonIframe extends LitElement {
  @property({ type: String }) src = "";
  // HACK: The UI framework already translates the top level cell into updated
  // properties, but we want to only have to deal with one type of listening, so
  // we'll add a an extra level of indirection with the "context" property.
  @property({ type: Object }) context?: Cell<any> | any;

  private iframeRef: Ref<HTMLIFrameElement> = createRef();

  private handleMessage = (event: MessageEvent) => {
    console.log("Received message", event);
    if (event.source === this.iframeRef.value?.contentWindow) {
      const { type, key, data } = event.data;
      if (typeof key !== "string") {
        console.error("Invalid key type. Expected string.");
        return;
      }
      console.log(
        { type, key, data },
        this.context,
        typeof this.context?.get === "function" ? "cell" : "not cell"
      );
      console.log(
        "data",
        this.context,
        this.context?.get && this.context?.get(),
        this.context?.getAsProxy && this.context?.getAsProxy()
      );
      if (type === "read" && this.context) {
        const value = this.context?.getAsProxy
          ? this.context?.getAsProxy([key])
          : this.context?.[key];
        // TODO: This might cause infinite loops, since the data can be a graph.
        const copy = JSON.parse(JSON.stringify(value ?? {}));
        console.log("readResponse", key, value);
        this.iframeRef.value?.contentWindow?.postMessage(
          { type: "readResponse", key, data: copy },
          "*"
        );
      } else if (type === "write" && this.context) {
        this.context.getAsProxy()[key] = data;
      }
    }
  };
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
