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
            ${repeat(node.messages, (node: any) => {
        if (node.role === 'user') {
          return html`<com-prompt slot="prompt">
              ${node.content}
            </com-prompt>`
        } else {
          return html`<com-response slot="response">${node.content}</com-response>`
        }
      })}
          </com-thread-group>
        `)}
    `
  }
}
