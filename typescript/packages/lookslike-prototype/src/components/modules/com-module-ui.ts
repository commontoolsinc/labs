import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { RuntimeNode } from "../../reactivity/runtime.js";
import { effect } from "@vue/reactivity";

const styles = css``;

@customElement("com-module-ui")
export class ComModuleUi extends LitElement {
  static override styles = [styles];

  @property() node: RuntimeNode | null = null;
  @state() value: any = null;

  override connectedCallback() {
    super.connectedCallback();
    effect(() => {
      this.value = this.node?.read();
    });
  }

  override render() {
    if (!this.node || !this.value) {
      return html`<pre>loading...</pre>`;
    }
    const sourceHtml = this.value.outerHTML;

    return html`<div>${this.value}</div>
      <com-toggle>
        <com-data .data=${sourceHtml}></com-data>
        <com-data
          .data=${JSON.stringify(this.node.definition.body, null, 2)}
        ></com-data>
      </com-toggle>`;
  }
}
