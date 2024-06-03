import { LitElement, html, css } from 'lit-element'
import { customElement, property } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { base } from '../styles'
import { createElement } from '../ui'
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import pretty from 'pretty'
import { createRxJSNetworkFromJson } from '../graph'
import { Recipe, RecipeNode } from '../data'

type Context = {
  inputs: { [node: string]: { [input: string]: any } },
  outputs: { [node: string]: any },
}

function snapshot(ctx: Context) {
  const snapshot: Context = {
    inputs: {},
    outputs: {}
  }

  for (const key in ctx.outputs) {
    const value = ctx.outputs[key].getValue()
    snapshot.outputs[key] = value
  }

  for (const key in ctx.inputs) {
    snapshot.inputs[key] = {}
    for (const inputKey in ctx.inputs[key]) {
      const value = ctx.inputs[key][inputKey].getValue()
      snapshot.inputs[key][inputKey] = value
    }
  }

  return snapshot
}

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
    return html`<pre>${node.body}</pre><com-toggle><pre class="code">${JSON.stringify(val, null, 2)}</pre></com-toggle>`
  }

  if (node.contentType === 'application/json+vnd.common.ui') {
    const el = createElement(node.body, snapshot(context).outputs)

    return html`<div>${unsafeHTML(el.outerHTML)}</div>
      <com-toggle>
      <pre class="code">${pretty(el.outerHTML)}</pre>
      <pre class="code">${JSON.stringify(node.body, null, 2)}</pre>
      </com-toggle>`
  }

  return html`<pre>${JSON.stringify(node, null, 2)}</pre>`
}

@customElement('com-thread')
export class ComThread extends LitElement {
  static styles = [base, styles]

  @property({ type: Object }) graph = {} as Recipe

  response(node: RecipeNode, context: object) {
    return html`<com-response slot="response">
        ${definitionToHtml(node, context)}
        <code class="local-variable">${node.id}</code>
      </com-response>`
  }

  render() {
    const context = createRxJSNetworkFromJson(this.graph)

    return html`
      ${repeat(
      this.graph,
      (node) => html`
          <com-thread-group>
            ${repeat(
        node.messages.filter(m => m.role === 'user'),
        (node) => {
          return html`<com-prompt slot="prompt">
                      ${node.content}
                    </com-prompt>`
        })}
            ${this.response(node, context)}
          </com-thread-group>
        `)
      }
    `
  }
}
