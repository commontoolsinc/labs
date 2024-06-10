import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { base } from "../styles";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
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

  if (node.contentType === "text/javascript") {
    const codeChanged = (ev) => {
      node.body = ev.detail.code;
      const event = new CustomEvent("updated", {
        detail: {
          body: node.body
        }
      });
      dispatch(event);
    };

    const dataChanged = (ev) => {
      const event = new CustomEvent("overriden", {
        detail: {
          data: ev.detail.data
        }
      });
      dispatch(event);
    };

    return html`
      <com-code .code=${node.body} @updated=${codeChanged}></com-code>
      <com-data
        .data=${JSON.stringify(value, null, 2)}
        @updated=${dataChanged}
      ></com-data>
    `;
  }

  if (node.contentType === "application/json+vnd.common.ui") {
    if (!value) {
      return html`<pre>loading...</pre>`;
    }
    // const el = createElement(node.body, context || {})
    const sourceHtml = value.outerHTML;

    console.log("sourceHtml", sourceHtml);
    return html`<div>${unsafeHTML(sourceHtml)}</div>
      <com-toggle>
        <com-data .data=${sourceHtml}></com-data>
        <com-data .data=${JSON.stringify(node.body, null, 2)}></com-data>
      </com-toggle>`;
  }

  if (node.contentType === "application/json") {
    return html`
      <com-data .data=${node.body}></com-data>
      <com-data .data=${JSON.stringify(value, null, 2)}></com-data>
    `;
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
      // trigger a re-render if any output changes
      this.cancel = signal.effect([this.output], (value) => {
        // if (!value) return
        this.value = value;
        console.log("updated value", this.node?.id, value);
      });
    }
  }

  override render() {
    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }

    const defintion = definitionToHtml(
      this.node,
      this.value,
      this.dispatchEvent.bind(this)
    );
    console.log("value", this.node.id, this.value);

    return html`
      <div class="main">
        ${defintion}
        <slot></slot>
      </div>
    `;
  }
}
