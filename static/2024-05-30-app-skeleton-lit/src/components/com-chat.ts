import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
  :host {
    display: block;

    display: grid;
    grid-template-rows: 1fr min-content;
    grid-template-areas:
      "main"
      "footer";
    height: 100cqh;

    > com-chat-main {
      grid-area: main;
      overflow-y: auto;
      overflow-x: hidden;
    }

    > com-chat-footer {
      grid-area: footer;
    }
  }
`

@customElement('com-chat')
export class ComAppGrid extends LitElement {
  static styles = [base, styles]

  render() {
    return html`
      <com-chat-main>
        <slot name="main"></slot>
      </com-chat-main>
      <com-chat-footer>
        <slot name="footer"></slot>
      </com-chat-footer>
    `
  }
}

