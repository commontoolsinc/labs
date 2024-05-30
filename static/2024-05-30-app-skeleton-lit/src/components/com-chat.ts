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
        <com-content>
          <slot name="main"></slot>
        </com-content>
      </com-chat-main>
      <com-chat-footer>
        <com-content>
          <slot name="footer"></slot>
        </com-content>
      </com-chat-footer>
    `
  }
}

