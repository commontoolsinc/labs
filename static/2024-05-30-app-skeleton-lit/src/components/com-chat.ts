import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
  :host {
    display: block;
  }

  .layout {
    display: grid;
    grid-template-rows: 1fr min-content;
    grid-template-areas:
      "main"
      "footer";
      height: 100cqh;
  }

  .main {
    grid-area: main;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--gap);
  }

  .footer {
    grid-area: footer;
    padding: 0 var(--gap) var(--gap);
  }
`

@customElement('com-chat')
export class ComChat extends LitElement {
  static styles = [base, styles]

  render() {
    return html`
    <div class="layout">
      <div class="main">
        <com-content>
          <slot name="main"></slot>
        </com-content>
      </div>
      <div class="footer">
        <com-content>
          <slot name="footer"></slot>
        </com-content>
      </div>
    </div>
    `
  }
}

