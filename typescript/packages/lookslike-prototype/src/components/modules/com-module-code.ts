import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";
import {
  WASM_SANDBOX,
  SES_SANDBOX,
  CONFIDENTIAL_COMPUTE_SANDBOX
} from "@commontools/runtime";

const styles = css``;

@customElement("com-module-code")
export class ComModuleCode extends LitElement {
  static override styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;

  override render() {
    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }

    // HACK: force SES by default
    this.node.evalMode = this.node.evalMode || SES_SANDBOX;

    const codeChanged = (ev: CustomEvent) => {
      if (!this.node) return;

      this.node.body = ev.detail.code;
      const event = new CustomEvent("updated", {
        detail: {
          body: this.node.body
        }
      });
      this.dispatchEvent(event);
    };

    const dataChanged = (ev: CustomEvent) => {
      const event = new CustomEvent("overriden", {
        detail: {
          data: ev.detail.data,
          json: true
        }
      });
      this.dispatchEvent(event);
    };

    const onChangeEvalMode = (ev: Event) => {
      const select = ev.target as HTMLSelectElement;
      this.node.evalMode = select.value as any;
      this.requestUpdate();
    };

    return html`
      <com-code .code=${this.node.body} @updated=${codeChanged}></com-code>
      <select
        name="evalMode"
        @change=${onChangeEvalMode}
        .value=${this.node.evalMode}
      >
        <option value=${SES_SANDBOX}>SES</option>
        <option value=${WASM_SANDBOX}>WASM</option>
        <option value=${CONFIDENTIAL_COMPUTE_SANDBOX}>
          CONFIDENTIAL COMPUTE
        </option>
      </select>
    `;
  }
}
