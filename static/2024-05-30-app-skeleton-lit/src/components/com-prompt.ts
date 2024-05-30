import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
:host {
  display: block;
}

.main {
  padding: var(--gap);

  &:focus {
    outline: none;
  }
}
`

@customElement('com-prompt')
export class ComPrompt extends LitElement {
  static styles = [base, styles]

  render() {
    return html`
    <div class="main">
      <slot></slot>
    </div>
    `
  }
}
