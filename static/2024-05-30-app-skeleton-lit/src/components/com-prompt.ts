import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
:host {
  display: block;
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
    return html`<slot></slot>`
  }
}
