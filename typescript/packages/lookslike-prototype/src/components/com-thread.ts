import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { base } from "../styles.js";
import { createRxJSNetworkFromJson } from "../graph.js";
import { Recipe, RecipeNode } from "../data.js";
import { Context } from "../state.js";
import { SignalSubject } from "../../../common-frp/lib/signal.js";
import { Gem, read, write } from "../gems.js";

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

  .local-variable {
    font-size: 0.5rem;
    font-family: monospace;
    border: 1px solid #ccc;
    padding: 0 0.5rem;
    background-color: #f0f0f0;
  }
`;

// foreach node, re-render it only when the output changes?

@customElement("com-thread")
export class ComThread extends LitElement {
  static override styles = [base, styles];

  @property({ type: Object }) graph = {} as Recipe;
  @state() context = {} as Context<Gem<any>>;

  @property({ type: Function }) setContext = (_: Context<Gem<any>>) => {};

  lastGraph: Recipe = [];
  localScope: { [k: string]: any } = {};

  response(node: RecipeNode) {
    const onOverriden = async (e: CustomEvent) => {
      console.log(node.id, "override", e.detail);
      await write(this.context.outputs[node.id], JSON.parse(e.detail.data));
    };

    const onRefresh = () => {
      this.graph = JSON.parse(JSON.stringify(this.graph));
    };

    const onUpdated = (e: CustomEvent) => {
      node.body = e.detail.body;
      onRefresh();
    };

    const onRun = async () => {
      const val = await read(this.context.outputs[node.id]);
      await write(this.context.outputs[node.id], val);
    };

    if (!this.context?.outputs?.[node.id]) return html`<pre>wait</pre>`;

    return html`<com-response
      slot="response"
      .node=${node}
      .output=${this.context.outputs[node.id]}
      @updated=${onUpdated}
      @overriden=${onOverriden}
      @run=${onRun}
    >
      <code class="local-variable">${node.id}</code>
      ${repeat(
        Object.entries(node.in),
        ([key, value]) =>
          html`<code class="local-variable">${key}: ${value}</code>`
      )}
    </com-response>`;
  }

  override async willUpdate(
    changedAttributes: Map<string, any>
  ): Promise<void> {
    if (
      changedAttributes.has("graph") &&
      JSON.stringify(this.graph) !== JSON.stringify(this.lastGraph)
    ) {
      console.log("rebuilding graph");
      this.context.cancellation?.forEach((cancel) => cancel());

      this.context = await createRxJSNetworkFromJson(this.graph);
      this.lastGraph = this.graph;
    }
  }

  override render() {
    return html`
      ${repeat(
        this.graph,
        (node) => html`
          <com-thread-group> ${this.response(node)} </com-thread-group>
        `
      )}
    `;
  }
}
