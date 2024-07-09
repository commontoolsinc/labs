import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { base } from "../styles.js";
import { Recipe, RecipeNode, SpecTree } from "../data.js";
import { Context } from "../state.js";
import { appGraph, appPlan, appState } from "./com-app.js";
import { effect } from "@vue/reactivity";
import { Graph } from "../reactivity/runtime.js";
import { cursor } from "../agent/cursor.js";
import { watch } from "../reactivity/watch.js";

const styles = css`
  :host {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));

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
`;

// foreach node, re-render it only when the output changes?

@customElement("com-thread")
export class ComThread extends LitElement {
  static override styles = [base, styles];

  @state() graph: Graph | null = null;
  @state() state: any | null = null;
  @state() plan: SpecTree | null = null;

  response(node: RecipeNode) {
    return html`<com-response slot="response" .node=${node}></com-response>`;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    effect(() => {
      console.log("com-thread", appGraph, appState, appPlan);
      this.graph = appGraph;
      this.state = { ...appState };
      this.plan = { ...appPlan };
    });
  }

  override render() {
    if (this.graph == null || this.plan == null) {
      return html`<pre>empty...</pre>`;
    }
    const tree: Recipe = this.graph.save();
    const plan = this.plan;
    const connections = tree.connections || {};

    console.log("render", this.plan, this.graph);

    const onSelected = (target: HTMLElement, id: string) => {
      if (cursor.focus.some((e) => e.id === id)) {
        cursor.focus = cursor.focus.filter((e) => e.id !== id);
        return;
      }

      cursor.focus.push({ id, element: target });
    };

    return html`<ul>
      ${plan.steps.map((step) => {
        return html`<li>
          <em><pre>${step.description}</pre></em>
          <ul>
            ${step.associatedNodes.map((nodeId) => {
              const node = tree.nodes.find((node) => node.id === nodeId);
              if (!node) {
                return html`<li>Node not found: ${nodeId}</li>`;
              }

              return html`<li data-node-id=${nodeId}>
                <div>
                  ${repeat(
                    Object.entries(connections[node.id] || {}),
                    ([key, value]) =>
                      html`<code class="local-variable"
                        >${key}: ${value} = ${watch(appState, value)}</code
                      >`
                  )}
                </div>
                <input
                  type="checkbox"
                  @change=${(ev: CustomEvent) => onSelected(ev.target, node.id)}
                />
                <strong><code>${node.id}</code></strong>
                <code>${node.contentType}</code>

                ${this.response(node)}
              </li>`;
            })}
          </ul>
        </li>`;
      })}
    </ul>`;
  }
}
