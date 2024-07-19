import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { RuntimeNode } from "../../reactivity/runtime.js";
import { effect } from "@vue/reactivity";
import { formatDataForConsole } from "../../text.js";

const styles = css``;

@customElement("com-module-data")
export class ComModuleData extends LitElement {
  static override styles = [styles];

  @property() node!: RuntimeNode;
  @state() value: any = null;

  override connectedCallback() {
    super.connectedCallback();
    effect(() => {
      this.value = this.node?.read();
    });
  }

  override render() {
    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }

    const onUpdated = (ev) => {
      this.node.write(JSON.parse(ev.detail.data));
      this.node.update();
    };

    return html`
      <com-data
        .data=${formatDataForConsole(this.value)}
        @updated=${onUpdated}
      ></com-data>
    `;
  }
}
