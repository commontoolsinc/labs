import { LitElement, html, css } from 'lit-element'
import { customElement, property } from 'lit/decorators.js'
import { base } from '../styles'

const styles = css`
  :host {
    display: block;
  }

  .editor {
    background: transparent;
    display: block;
    border: none;
    padding: 0;
    width: 100%;
    font-size: var(--body-size, 16px);
    font-family: var(--body-font, sans-serif);
    line-height: var(--body-line, 1.5em);
    min-height: var(--body-line, 1.5em);
    overflow: hidden;
    resize: none;

    &:focus {
      outline: none;
    }
  }
`

@customElement('com-editor')
export class ComEditor extends LitElement {
  static styles = [base, styles]

  @property({ type: String }) value = ''
  @property({ type: Function }) setValue = (_: string) => { }

  render() {
    const oninput = (event: InputEvent) => {
      const textarea = event.target as HTMLTextAreaElement
      this.setValue(textarea.value)
    }

    return html`
      <textarea class="editor" @input=${oninput} .value=${this.value}></textarea>
    `
  }

  #updateTextareaHeight() {
    const textarea = this.shadowRoot?.querySelector('.editor') as HTMLTextAreaElement
    textarea.style.height = '0px'
    const height = textarea.scrollHeight
    textarea.style.height = `${height}px`
  }

  protected updated(
    changedProperties: Map<PropertyKey, any>
  ): void {
    if (changedProperties.has('value')) {
      this.#updateTextareaHeight()
    }
  }
}
