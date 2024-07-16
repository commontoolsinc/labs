import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";
import {
  WASM_SANDBOX,
  SES_SANDBOX,
  CONFIDENTIAL_COMPUTE_SANDBOX
} from "@commontools/runtime";
import { RuntimeNode } from "../../reactivity/runtime.js";
import { effect } from "@vue/reactivity";
import { formatDataForConsole } from "../../text.js";

const styles = css``;

@customElement("com-module-event-listener")
export class ComModuleEventListener extends LitElement {
  static override styles = [styles];

  @property() node!: RuntimeNode;
  @state() value: any = null;

  override connectedCallback() {
    super.connectedCallback();
    effect(() => {
      this.value = this.node?.read();
    });
  }

  override render() {
    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }

    const codeChanged = (ev: CustomEvent) => {
      if (!this.node) return;

      this.node.definition.body.code = ev.detail.code;
      this.node.update();
    };

    const onChangeEvalMode = (ev: Event) => {
      const select = ev.target as HTMLSelectElement;
      if (!this.node) return;
      this.node.definition.evalMode = select.value as any;
      this.requestUpdate();
    };

    return html`
      <code>${this.node.definition.body.event}</code>
      <com-code
        .code=${this.node.definition.body.code}
        @updated=${codeChanged}
      ></com-code>
      <com-toggle>
        <select
          name="evalMode"
          @change=${onChangeEvalMode}
          .value=${this.node.definition.evalMode}
        >
          <option value=${SES_SANDBOX}>SES</option>
          <option value=${WASM_SANDBOX}>WASM</option>
          <option value=${CONFIDENTIAL_COMPUTE_SANDBOX}>
            CONFIDENTIAL COMPUTE
          </option>
        </select>
        <com-data .data=${formatDataForConsole(this.value)}></com-data>
      </com-toggle>
    `;
  }
}
