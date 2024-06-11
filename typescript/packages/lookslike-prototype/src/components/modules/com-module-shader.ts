import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";

const styles = css``;

@customElement("com-module-shader")
export class ComModuleShader extends LitElement {
  static styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;

  override render() {
    if (!this.node || !this.value) {
      return html`<pre>loading...</pre>`;
    }

    const codeChanged = (ev) => {
      this.node.body = ev.detail.code;
      const event = new CustomEvent("updated", {
        detail: {
          body: this.node.body
        }
      });
      this.dispatchEvent(event);
    };

    return html`
      <com-code .code=${this.node.body} @updated=${codeChanged}></com-code>
      <com-shader .fragmentShader=${this.node.body}></com-shader>
    `;
  }
}
