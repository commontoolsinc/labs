import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { base } from "../styles";
import { RecipeNode } from "../data.js";
import { SignalSubject } from "../../../common-frp/lib/signal.js";
import { signal } from "@commontools/common-frp";

function definitionToHtml(
  node: RecipeNode,
  value: any,
  dispatch: (event: CustomEvent) => void
) {
  if (!node) {
    return html`<pre>loading...</pre>`;
  }

  const relay = (ev: CustomEvent) => {
    dispatch(
      new CustomEvent("updated", {
        detail: {
          body: ev.detail.body
        }
      })
    );
  };

  if (node.contentType === "text/javascript") {
    return html`<com-module-code
      .node=${node}
      .value=${value}
      @updated=${relay}
    ></com-module-code>`;
  }

  if (node.contentType === "application/json+vnd.common.ui") {
    return html`<com-module-ui .node=${node} .value=${value}></com-module-ui>`;
  }

  if (node.contentType === "application/json+vnd.common.fetch") {
    return html`<com-module-fetch
      .node=${node}
      .value=${value}
    ></com-module-fetch>`;
  }

  if (node.contentType === "application/json+vnd.common.llm") {
    return html`<com-module-llm
      .node=${node}
      .value=${value}
    ></com-module-llm>`;
  }

  if (node.contentType === "application/json+vnd.common.image") {
    return html`<com-module-image
      .node=${node}
      .value=${value}
    ></com-module-image>`;
  }

  if (node.contentType === "text/glsl") {
    return html`<com-module-shader
      .node=${node}
      .value=${value}
      @updated=${relay}
    ></com-module-shader>`;
  }

  return html`<pre>${JSON.stringify(node, null, 2)}</pre>`;
}

const styles = css`
  :host {
    display: block;
  }

  .main {
    background-color: var(--color-secondary-background);
    padding: var(--gap);

    &:focus {
      outline: none;
    }
  }
`;

@customElement("com-response")
export class ComResponse extends LitElement {
  static styles = [base, styles];

  @property({ type: Object }) node: RecipeNode | null;
  @property({ type: Object }) output: SignalSubject<any> = signal.state(null);
  onCancel: () => void = () => {};
  @state() value: any = {};
  cancel: () => void = () => {};

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>
  ) {
    if (changedProperties.has("output")) {
      console.log("output changed", this.node?.id, this.output);
      this.cancel();
      // trigger a re-render if any output changes
      this.cancel = signal.effect([this.output], (value) => {
        if (!value || this.value === value) return;
        this.value = value;
        console.log("updated value", this.node?.id, value);
      });
    }
  }

  override render() {
    super.render();

    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }

    console.log("re-render", this.node.id, this.value);
    const definition = definitionToHtml(
      this.node,
      this.value,
      this.dispatchEvent.bind(this)
    );

    return html`
      <div class="main">
        ${definition}
        <slot></slot>
      </div>
    `;
  }
}
