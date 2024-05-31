import { LitElement, html, css } from 'lit-element'
import { customElement, property } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { base } from '../styles'
import { createElement } from '../ui'
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import pretty from 'pretty'


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
`

function definitionToHtml(definition?: any) {
  if (!definition) {
    return html`<pre>loading...</pre>`
  }

  if (definition.contentType === 'text/javascript') {
    return html`<pre>${definition.body}</pre>`
  }
  if (definition.contentType === 'application/json+vnd.common.ui') {
    const el = createElement(definition.body, {
      todos: [
        { label: 'test', checked: false },
        { label: 'test2', checked: true }
      ]
    })

    console.log(el)

    return html`<div>${unsafeHTML(el.outerHTML)}</div><pre class="code">${pretty(el.outerHTML)}</pre>`
  }
  return html`<pre>${JSON.stringify(definition, null, 2)}</pre>`
}

@customElement('com-thread')
export class ComThread extends LitElement {
  static styles = [base, styles]

  @property({ type: Object }) graph = {} as any

  response(node) {
    if (node.definition) {
      return html`<com-response slot="response">
        ${definitionToHtml(node.definition)}
      </com-response>`
    } else {
      return html`<com-response slot="response">
        ${node.messages.filter(m => m.role !== 'user').map(m => m.content).join(' ')}
      </com-response>`
    }

  }

  render() {
    const sortedNodes = this.graph.order.map((orderId: string) =>
      this.graph.nodes.find((node: any) => node.id === orderId)
    );

    return html`
      ${repeat(
      sortedNodes,
      (node: any) => html`
          <com-thread-group>
            ${repeat(node.messages.filter(m => m.role === 'user'), (node: any) => {
        return html`<com-prompt slot="prompt">
                      ${node.content}
                    </com-prompt>`
      })}

            ${this.response(node)}
          </com-thread-group>
        `)
      }
    `
  }
}
