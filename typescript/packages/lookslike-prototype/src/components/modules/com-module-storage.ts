import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";

const styles = css``;

@customElement("com-module-storage")
export class ComModuleStorage extends LitElement {
  static override styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;

  override firstUpdated() {}

  override updated(changedProperties: Map<string | number | symbol, unknown>) {}

  override render() {
    if (!this.node || !this.value) {
      return html`<pre>loading...</pre>`;
    }

    return html`
      <div>
        <h1>${this.node.body}</h1>
        <com-data .data=${JSON.stringify(this.value, null, 2)}></com-data>
      </div>
    `;
  }
}
