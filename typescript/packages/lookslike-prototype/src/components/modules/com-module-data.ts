import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";
import {
  WASM_SANDBOX,
  SES_SANDBOX,
  CONFIDENTIAL_COMPUTE_SANDBOX
} from "@commontools/runtime";

const styles = css``;

@customElement("com-module-data")
export class ComModuleData extends LitElement {
  static override styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;

  override render() {
    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }

    return html` <com-data .data=${this.node.body}></com-data> `;
  }
}
