import { LitElement, html, css } from 'lit-element'
import { customElement, property } from 'lit/decorators.js'
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

function definitionToHtml(node: RecipeNode, context: any) {
  if (!node) {
    return html`<pre>loading...</pre>`
  }

  if (node.contentType === 'text/javascript') {
    const val = context[node.id]
    return html`<com-code .code=${node.body}></com-code><com-data .data=${JSON.stringify(val, null, 2)}></com-data>`
  }

  if (node.contentType === 'application/json+vnd.common.ui') {
    const val = context[node.id]
    if (!val) {
      return html`<pre>loading...</pre>`
    }
    const el = createElement(node.body, context || {})
    const sourceHtml = el.outerHTML

    console.log('sourceHtml', sourceHtml)
    return html`<div>${unsafeHTML(sourceHtml)}</div>
      <com-toggle>
      <com-data .data=${pretty(sourceHtml)}></com-data>
      <com-data .data=${JSON.stringify(node.body, null, 2)}></com-data>
      </com-toggle>`
  }

  if (node.contentType === 'application/json') {
    const val = context[node.id]
    return html`<com-data .data=${node.body}></com-data><com-data .data=${JSON.stringify(val, null, 2)}></com-data>`
  }

  return html`<pre>${JSON.stringify(node, null, 2)}</pre>`
}

@customElement('com-thread')
export class ComThread extends LitElement {
  static styles = [base, styles]

  @property({ type: Object }) graph = {} as Recipe
  @property({ type: Object }) context = {} as Context<SignalSubject<any>>

  @property({ type: Function }) setContext = (_: Context<SignalSubject<any>>) => { }


  lastGraph: Recipe = []
  localScope: { [k: string]: any }
  onCancel: () => void

  response(node: RecipeNode, context: object) {
    return html`<com-response slot="response">
        ${definitionToHtml(node, context)}
        <code class="local-variable">${node.id}</code>
        ${repeat(Object.entries(node.in), ([key, value]) => html`<code class="local-variable">${key}: ${value}</code>`)}
      </com-response>`
  }

  override render() {
    if (this.graph != this.lastGraph) {
      // if (this.context) {
      //   this.context.cancellation?.forEach((cancel) => cancel())
      // }
      const context = createRxJSNetworkFromJson(this.graph)

      const dependencies = [...Object.values(context.outputs)]
      const combined = signal.computed(dependencies, (...outputs) => {
        return outputs
      });

      this.onCancel?.()
      // trigger a re-render if any output changes
      const cancel = signal.effect(combined, values => {
        if (!values) return
        this.localScope = Object.fromEntries(values.map((v, i) => [Object.keys(context.outputs)[i], v]))
        // this.setContext(context)
        this.requestUpdate()
      })

      this.onCancel = cancel
      this.lastGraph = this.graph
    }

    return html`
      ${repeat(
      this.graph,
      (node) => html`
          <com-thread-group>
            ${repeat(
        node.messages?.filter(m => m.role === 'user') || [],
        (node) => {
          return html`<com-prompt slot="prompt">
                      ${node.content}
                    </com-prompt>`
        })}
            ${this.response(node, this.localScope)}
          </com-thread-group>
        `)
      }
    `
  }
}
