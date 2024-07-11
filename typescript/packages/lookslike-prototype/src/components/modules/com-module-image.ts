import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";
import { RuntimeNode } from "../../reactivity/runtime.js";
import { watch } from "../../reactivity/watch.js";

const styles = css``;

@customElement("com-module-image")
export class ComModuleImage extends LitElement {
  static override styles = [styles];

  @property() node: RuntimeNode | null = null;

  override render() {
    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }

    return html`
      <img src=${watch(this.node.read())} style="max-width: 100%"></img>
      <caption>${watch(this.node.read())}></caption>
    `;
  }
}
