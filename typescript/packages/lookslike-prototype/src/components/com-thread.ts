import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { base } from "../styles.js";
import { GraphSnapshot, Recipe, RecipeNode, SpecTree } from "../data.js";
import { Context } from "../state.js";
import { appGraph } from "./com-app.js";

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

  @state() graphSnapshot: GraphSnapshot = null;

  response(node: RecipeNode) {
    return html`<com-response slot="response" .node=${node}>
      <code class="local-variable">${node.id}</code>
      ${repeat(
        appGraph.listInputsForNode(node.id),
        ([key, value]) =>
          html`<code class="local-variable">${key}: ${value}</code>`
      )}
    </com-response>`;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.graphSnapshot = appGraph.snapshot();
    appGraph.changes.subscribe((g) => {
      console.log("graph changed", g);
      this.graphSnapshot = g;
    });
  }

  override render() {
    if (this.graphSnapshot == null) {
      return html`<pre>empty...</pre>`;
    }
    const tree: Recipe = this.graphSnapshot.recipeTree;
    const connections = this.graphSnapshot.recipeTree.connections || {};

    // walk tree and render as nested <ul> tags
    function renderTree(recipe: Recipe) {
      return html`<ul>
        ${recipe.spec.steps.map((step) => {
          return html`<li>
            <em><pre>${step.description}</pre></em>
            <ul>
              ${step.associatedNodes.map((nodeId) => {
                const node = tree.nodes.find((node) => node.id === nodeId);
                if (!node) {
                  return html`<li>Node not found: ${nodeId}</li>`;
                }

                return html`<li>
                  <div>
                    ${repeat(
                      Object.entries(connections[node.id] || {}),
                      ([key, value]) =>
                        html`<code class="local-variable"
                          >${key}: ${value}</code
                        >`
                    )}
                  </div>
                  <strong><code>${node.id}</code></strong>
                  <code>${node.contentType}</code>
                  <pre class="node-body">
${typeof node.body === "string"
                      ? node.body
                      : JSON.stringify(node.body, null, 2)}</pre
                  >
                </li>`;
              })}
            </ul>
          </li>`;
        })}
      </ul>`;
    }

    return html`<div>${renderTree(tree)}</div>`;
  }
}
