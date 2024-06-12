import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

const styles = css``;

@customElement("com-module-ui")
export class ComModuleUi extends LitElement {
  static override styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;

  override render() {
    if (!this.node || !this.value) {
      return html`<pre>loading...</pre>`;
    }
    const sourceHtml = this.value.outerHTML;

    return html`<div>${unsafeHTML(sourceHtml)}</div>
      <com-toggle>
        <com-data .data=${sourceHtml}></com-data>
        <com-data .data=${JSON.stringify(this.node.body, null, 2)}></com-data>
      </com-toggle>`;
  }
}
