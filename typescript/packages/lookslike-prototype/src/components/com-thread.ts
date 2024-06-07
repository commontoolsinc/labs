import { LitElement, html, css } from 'lit-element'
import { customElement, property, state } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { base } from '../styles.js'
import { createElement } from '../ui.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import pretty from 'pretty'
import { createRxJSNetworkFromJson } from '../graph.js'
import { Recipe, RecipeNode } from '../data.js'
import { Context, snapshot } from '../state.js'
import { signal } from '@commontools/common-frp'
import { SignalSubject } from '../../../common-frp/lib/signal.js'

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

  .local-variable {
    font-size: 0.5rem;
    font-family: monospace;
    border: 1px solid #ccc;
    padding: 0 0.5rem;
    background-color: #f0f0f0;
  }
`



// foreach node, re-render it only when the output changes?

@customElement('com-thread')
export class ComThread extends LitElement {
  static styles = [base, styles]

  @property({ type: Object }) graph = {} as Recipe
  @state() context = {} as Context<SignalSubject<any>>

  @property({ type: Function }) setContext = (_: Context<SignalSubject<any>>) => { }


  lastGraph: Recipe = []
  localScope: { [k: string]: any } = {}

  response(node: RecipeNode) {
    return html`<com-response slot="response" .node=${node} .output=${this.context.outputs[node.id]}>
        <code class="local-variable">${node.id}</code>
        ${repeat(Object.entries(node.in), ([key, value]) => html`<code class="local-variable">${key}: ${value}</code>`)}
      </com-response>`
  }

  override willUpdate(changedAttributes: Map<string, any>): void {
    if (changedAttributes.has('graph')) {
      this.context.cancellation?.forEach((cancel) => cancel())
      this.context = createRxJSNetworkFromJson(this.graph)
    }
  }

  override render() {
    return html`
      ${repeat(
      this.graph,
      (node) => html`
          <com-thread-group>
            ${this.response(node)}
          </com-thread-group>
        `)
      }
    `
  }
}
