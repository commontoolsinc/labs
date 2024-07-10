import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { base } from "../styles.js";
import { RecipeNode } from "../data.js";
import {
  CONTENT_TYPE_FETCH,
  CONTENT_TYPE_GLSL,
  CONTENT_TYPE_IMAGE,
  CONTENT_TYPE_JAVASCRIPT,
  CONTENT_TYPE_LLM,
  CONTENT_TYPE_UI,
  CONTENT_TYPE_EVENT,
  CONTENT_TYPE_CLOCK,
  CONTENT_TYPE_STORAGE,
  CONTENT_TYPE_SCENE,
  CONTENT_TYPE_DATA
} from "../contentType.js";
import { appState } from "./com-app.js";
import { effect } from "@vue/reactivity";

function renderNode(
  node: RecipeNode,
  value: any,
  dispatch: (event: CustomEvent) => void
) {
  if (!node) {
    return html`<pre>loading...</pre>`;
  }

  const relay = (ev: CustomEvent) => {
    dispatch(
      new CustomEvent(ev.type, {
        detail: {
          body: ev.detail?.body
        }
      })
    );
  };

  switch (node.contentType) {
    case CONTENT_TYPE_JAVASCRIPT:
      return html`<com-module-code
        .node=${node}
        .value=${value}
        @updated=${relay}
      ></com-module-code>`;
    case CONTENT_TYPE_UI:
      return html`<com-module-ui
        .node=${node}
        .value=${value}
      ></com-module-ui>`;
    case CONTENT_TYPE_FETCH:
      return html`<com-module-fetch
        .node=${node}
        .value=${value}
      ></com-module-fetch>`;
    case CONTENT_TYPE_LLM:
      return html`<com-module-llm
        .node=${node}
        .value=${value}
      ></com-module-llm>`;
    case CONTENT_TYPE_IMAGE:
      return html`<com-module-image
        .node=${node}
        .value=${value}
      ></com-module-image>`;
    case CONTENT_TYPE_GLSL:
      return html`<com-module-shader
        .node=${node}
        .value=${value}
        @updated=${relay}
      ></com-module-shader>`;
    case CONTENT_TYPE_CLOCK:
      return html`<com-module-event
        .node=${node}
        .value=${value}
        @run=${relay}
      ></com-module-event>`;
    case CONTENT_TYPE_SCENE:
      if (!value) return html``;
      return html`<com-module-scene
        .node=${node}
        .value=${value}
      ></com-module-scene>`;
    case CONTENT_TYPE_DATA:
      return html`<com-module-data
        .node=${node}
        .value=${value}
      ></com-module-data>`;
  }

  return html`<pre>${JSON.stringify(node, null, 2)}</pre>`;
}

const styles = css`
  :host {
    display: block;
  }

  .response {
    background-color: var(--color-card);
    padding: var(--gap);

    &:focus {
      outline: none;
    }
  }
`;

@customElement("com-response")
export class ComResponse extends LitElement {
  static override styles = [base, styles];

  @property({ type: Object }) node: RecipeNode | null = null;
  onCancel: () => void = () => {};
  @state() value: any = {};
  cancel: () => void = () => {};

  override connectedCallback(): void {
    super.connectedCallback();

    effect(() => {
      if (!this.node) return;
      this.value = appState[this.node.id];
    });
  }

  override render() {
    super.render();

    if (!this.node) {
      return html`<pre>loading...</pre>`;
    }

    console.log("re-render", this.node.id, this.value);
    const definition = renderNode(
      this.node,
      this.value,
      this.dispatchEvent.bind(this)
    );

    const onRun = () => {
      this.dispatchEvent(new CustomEvent("run"));
    };

    return html`
      <div class="response">
        ${definition}
        <slot></slot>
        <button @click=${onRun}>Run</button>
      </div>
    `;
  }
}
