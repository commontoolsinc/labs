import { LitElement, html, css } from 'lit-element'
import { customElement, property } from 'lit/decorators.js'
import { base } from '../styles'

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

  @property({ type: String }) value = ''
  @property({ type: Function }) onInput = (txt) => { }

  render() {
    return html`
    <textarea class="editor" type="text" @input=${(v) => this.onInput(v.target.value)}>${this.value}</textarea>
    `
  }
}
