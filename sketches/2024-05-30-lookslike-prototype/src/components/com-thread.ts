import { LitElement, html, css } from 'lit-element'
import { customElement, property } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { base } from '../styles'


const styles = css`
  :host {
    display: flex;
    flex-direction: column;
    gap: var(--gap);
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
    return html`<pre>${JSON.stringify(definition.body, null, 2)}</pre>`
  }
  return html`<pre>${JSON.stringify(definition, null, 2)}</pre>`
}

@customElement('com-thread')
export class ComThread extends LitElement {
  static styles = [base, styles]

  @property({ type: Object }) graph = {} as any

  render() {
    return html`
      ${repeat(
      this.graph.nodes,
      (node: any) => html`
          <com-thread-group>
            ${repeat(node.messages.filter((m: any) => m.role === 'user'), (node: any) => {

        return html`<com-prompt slot="prompt">
              ${node.content}
            </com-prompt>`
      })}

            <com-response slot="response">${definitionToHtml(node.definition)}</com-response>
          </com-thread-group>
        `)
      }
    `
  }
}
