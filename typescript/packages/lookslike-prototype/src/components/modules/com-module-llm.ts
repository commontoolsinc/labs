import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";

const styles = css``;

@customElement("com-module-llm")
export class ComModuleLlm extends LitElement {
  static override styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;

  override render() {
    if (!this.node || !this.value) {
      return html`<pre>loading...</pre>`;
    }

    return html`<com-markdown .markdown=${this.value}></com-markdown>`;
  }
}
