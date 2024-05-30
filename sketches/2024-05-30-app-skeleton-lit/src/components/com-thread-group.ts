import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
:host {
  background: var(--color-card);
  display: flex;
  flex-direction: column;
  border-radius: var(--radius);
  overflow: hidden;
}
`

@customElement('com-thread-group')
export class ComThreadGroup extends LitElement {
  static styles = [base, styles]

  render() {
    return html`
      <slot name="prompt"></slot>
      <slot name="response"></slot>
    `
  }
}
