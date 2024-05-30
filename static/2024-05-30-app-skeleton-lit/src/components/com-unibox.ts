import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
  :host {
    display: block;
  }

  .unibox {
    display: grid;
    background-color: var(--color-white);
    border-radius: var(--radius);
    grid-template-columns: 1fr min-content;
    grid-template-areas: "main end";
    gap: var(--gap);
    padding: calc(var(--unit) * 2);  
  }

  .unibox-main {
    grid-area: main;
    align-self: center;
  }

  .unibox-end {
    grid-area: end;
  }
`

@customElement('com-unibox')
export class ComUnibox extends LitElement {
  static styles = [base, styles]

  render() {
    return html`
    <div class="unibox">
      <div class="unibox-main">
        <slot name="main"></slot>
      </div>
      <div class="unibox-end">
        <slot name="end"></slot>
      </div>
    </div>
    `
  }
}

