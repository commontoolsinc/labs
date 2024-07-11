import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { base } from "../styles.js";
import { Message, Recipe, RecipeNode, SpecTree } from "../data.js";
import { appGraph, appState, session } from "./com-app.js";
import { computed, effect } from "@vue/reactivity";
import { Graph, RuntimeNode } from "../reactivity/runtime.js";
import { cursor } from "../agent/cursor.js";
import { watch } from "../reactivity/watch.js";
import { formatDataForPreview, truncate } from "../text.js";

const styles = css`
  :host {
    display: flex;
    flex-direction: column;

    gap: var(--gap);
  }

  /* temp styles, delete */
  .code {
    background: #f4f4f4;
    padding: 1rem;
    border-radius: 5px;
    font-size: 0.7rem;
    line-height: 1.5;
    margin-top: 1rem;
  }

  pre {
    white-space: pre-wrap;
  }

  pre.node-body {
    background: #f4f4f4;
    font-size: 0.7rem;
    line-height: normal;
    padding: 0.5rem;
    border-radius: 5px;
  }

  .local-variable {
    font-size: 0.5rem;
    font-family: monospace;
    border: 1px solid #ccc;
    padding: 0 0.5rem;
    background-color: #f0f0f0;
  }

  li {
    list-style-type: disc;
    margin-left: 1rem;
  }

  .history {
    position: fixed;
    bottom: 0;
    right: 0;
    border: 1px solid #ccc;
    background: #f0f0f0;
    padding: 0.5rem;
    border-radius: 5px;
  }
`;

// foreach node, re-render it only when the output changes?

@customElement("com-thread")
export class ComThread extends LitElement {
  static override styles = [base, styles];

  @state() graph: Graph | null = null;
  @state() state: any | null = null;
  @state() history: Message[] = [];

  response(node: RuntimeNode) {
    return html`<com-response slot="response" .node=${node}></com-response>`;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    effect(() => {
      console.log("com-thread", appGraph, appState, history);
      this.graph = appGraph;
      this.history = session.history;
      this.state = { ...appState };
    });
  }

  override render() {
    if (this.graph == null) {
      return html`<pre>empty...</pre>`;
    }
    const tree: Recipe = this.graph.save();
    const history = this.history;
    const connections = tree.connections || {};

    console.log("render", this.history, this.graph);

    const onSelected = (target: HTMLElement, id: string) => {
      if (cursor.focus.some((e) => e.id === id)) {
        cursor.focus = cursor.focus.filter((e) => e.id !== id);
        return;
      }

      cursor.focus.push({ id, element: target });
    };

    return html`<com-debug>
        ${history.map((message) => {
          return html`<pre>${message.content}</pre>`;
        })}
      </com-debug>
      <ul>
        ${[...this.graph.nodes.values()].map((node) => {
          return html`<li data-node-id=${node.id}>
            <div>
              ${repeat(
                Object.entries(connections[node.id] || {}),
                ([key, value]) =>
                  html`<code class="local-variable"
                    >${key}: ${value} =
                    ${watch(
                      computed(() => formatDataForPreview(appState[value]))
                    )}</code
                  >`
              )}
            </div>
            <input
              type="checkbox"
              @change=${(ev: CustomEvent) => onSelected(ev.target, node.id)}
            />
            <strong><code>${node.id}</code></strong>
            <code>${node.definition.contentType}</code>

            ${this.response(node)}
          </li>`;
        })}
      </ul>`;
  }
}
