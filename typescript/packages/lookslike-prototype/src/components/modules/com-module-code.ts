import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";

const styles = css``;

@customElement("com-module-code")
export class ComModuleCode extends LitElement {
  static styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;

  override render() {
    if (!this.node) {
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

    const dataChanged = (ev) => {
      const event = new CustomEvent("overriden", {
        detail: {
          data: ev.detail.data,
          json: true
        }
      });
      this.dispatchEvent(event);
    };

    return html`
      <com-code .code=${this.node.body} @updated=${codeChanged}></com-code>
      <com-data
        .data=${JSON.stringify(this.value, null, 2)}
        @updated=${dataChanged}
      ></com-data>
    `;
  }
}
