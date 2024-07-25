import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { webcamVideoTexture } from "../../webcam.js";
import { watch } from "@commontools/common-frp-lit";
import { RuntimeNode } from "../../reactivity/runtime.js";
import { effect } from "@vue/reactivity";

const styles = css``;

@customElement("com-module-shader")
export class ComModuleShader extends LitElement {
  static override styles = [styles];

  @property() node: RuntimeNode | null = null;
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

      this.node.definition.body = ev.detail.code;
      const event = new CustomEvent("updated", {
        detail: {
          body: this.node.definition.body
        }
      });
      this.dispatchEvent(event);
      this.node.update();
    };

    return html`
      <com-code
        .code=${this.node.definition.body}
        @updated=${codeChanged}
      ></com-code>
      <com-shader
        .fragmentShader=${this.node.definition.body}
        .webcam=${watch(webcamVideoTexture)}
      ></com-shader>
    `;
  }
}
