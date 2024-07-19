import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";
import { RuntimeNode } from "../../reactivity/runtime.js";
import { watch } from "../../reactivity/watch.js";

const styles = css``;

@customElement("com-module-fetch")
export class ComModuleFetch extends LitElement {
  static override styles = [styles];

  @property() node: RuntimeNode | null = null;

  override render() {
    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }
    return html`
      <com-data .data=${this.node.definition.body}></com-data>
      <com-data .data=${watch(this.node.read())}></com-data>
    `;
  }
}
