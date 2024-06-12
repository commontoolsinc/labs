import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";

const styles = css``;

@customElement("com-module-image")
export class ComModuleImage extends LitElement {
  static override styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;
  @state() history: any[] = [];

  override firstUpdated() {
    this.history = [];
    if (this.value) {
      this.history.push(this.value);
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (
      changedProperties.has("value") &&
      this.value &&
      !this.history.includes(this.value)
    ) {
      this.history.push(this.value);
    }
  }

  override render() {
    if (!this.node || !this.value) {
      return html`<pre>loading...</pre>`;
    }

    return html`
      <com-data .data=${JSON.stringify(this.value, null, 2)}></com-data>
      <img src=${this.value} style="max-width: 100%"></img>
      ${this.history.map(
        (value) => html`<img src=${value} style="max-width: 64px;"></img>`
      )}
    `;
  }
}
