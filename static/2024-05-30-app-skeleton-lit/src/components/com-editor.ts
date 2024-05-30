import {LitElement, html, css} from 'lit-element'
import {customElement, property} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
  :host {
    display: block;
  }

  .editor {
    display: block;

    &:focus {
      outline: none;
    }
  }
`

@customElement('com-editor')
export class ComEditor extends LitElement {
  static styles = [base, styles]

  @property({type: String}) value = ''

  render() {
    return html`
    <div class="editor" contenteditable="plaintext-only">${this.value}</div>
    `
  }
}
