import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
:host {
  display: block;
}

.main {
  background-color: var(--color-secondary-background);
  padding: var(--gap);

  &:focus {
      outline: none;
  }
}
`

@customElement('com-response')
export class ComResponse extends LitElement {
  static styles = [base, styles]

  render() {
    return html`
    <div class="main">
      <slot></slot>
    </div>
    `
  }
}
