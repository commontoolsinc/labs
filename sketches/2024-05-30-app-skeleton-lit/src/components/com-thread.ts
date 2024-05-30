import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

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

  render() {
    return html`<slot></slot>`
  }
}

