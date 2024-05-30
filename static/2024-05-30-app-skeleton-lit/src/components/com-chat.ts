import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
  :host {
    display: block;
  }
  .grid {
    display: grid;
    grid-template-rows: 1fr min-content;
    grid-template-areas:
        "main"
        "footer";
    height: 100cqh;

    > .main {
        grid-area: main;
        overflow-y: auto;
        overflow-x: hidden;
    }

    > .footer {
        grid-area: footer;
    }
  }
`

@customElement('com-chat')
export class ComAppGrid extends LitElement {
  static styles = [base, styles]

  render() {
    return html`
      <div class="grid">
        <div class="main">
          <slot name="main"></slot>
        </div>
        <div class="footer>
          <slot name="footer"></slot>
        </div>
      </div>
    `
  }
}

