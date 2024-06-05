import { LitElement, html, css } from 'lit-element'
import { customElement, property } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { base } from '../styles'
import { createElement } from '../ui'
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import pretty from 'pretty'
import { createRxJSNetworkFromJson } from '../graph'
import { Recipe, RecipeNode } from '../data'
import { Context, snapshot } from '../state'

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
    const val = snapshot(context).outputs[node.id]
    return html`<com-code .code=${node.body}></com-code><com-data .data=${JSON.stringify(val, null, 2)}></com-data>`
  }

  if (node.contentType === 'application/json+vnd.common.ui') {
    const el = createElement(node.body, snapshot(context).inputs[node.id] || {})

    return html`<div>${unsafeHTML(el.outerHTML)}</div>
      <com-toggle>
      <com-data .data=${pretty(el.outerHTML)}></com-data>
      <com-data .data=${JSON.stringify(node.body, null, 2)}></com-data>
      </com-toggle>`
  }

  if (node.contentType === 'application/json') {
    const val = snapshot(context).outputs[node.id]
    return html`<com-data .data=${node.body}></com-data><com-data .data=${JSON.stringify(val, null, 2)}></com-data>`
  }

  return html`<pre>${JSON.stringify(node, null, 2)}</pre>`
}

@customElement('com-thread')
export class ComThread extends LitElement {
  static styles = [base, styles]

  @property({ type: Object }) graph = {} as Recipe
  @property({ type: Object }) context = {} as Context

  @property({ type: Function }) setContext = (_: Context) => { }


  lastGraph: Recipe = []

  response(node: RecipeNode, context: object) {
    return html`<com-response slot="response">
        ${definitionToHtml(node, context)}
        <code class="local-variable">${node.id}</code>
        ${repeat(Object.entries(node.in), ([key, value]) => html`<code class="local-variable">${key}: ${value}</code>`)}
      </com-response>`
  }

  render() {
    if (this.graph != this.lastGraph) {
      this.context = createRxJSNetworkFromJson(this.graph)

      // trigger a re-render if any output changes
      Object.values(this.context.outputs).forEach((output) => {
        output.subscribe(() => {
          this.setContext(this.context)
          this.requestUpdate()
        })
      });
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
            ${this.response(node, this.context)}
          </com-thread-group>
        `)
      }
    `
  }
}
