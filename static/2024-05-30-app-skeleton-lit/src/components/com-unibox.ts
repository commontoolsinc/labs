import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
  :host {
    display: block;
  }

  .unibox {
    display: grid;
    grid-template-columns: min-content 1fr min-content;
    grid-template-areas: "start main end";
    gap: var(--gap);
  }

  .unibox-main {
    grid-area: main;
  }

  .unibox-start {
    grid-area: start;
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
    <menu class="unibox">
      <li class="unibox-start">
        <slot name="start"></slot>
      </li>
      <li class="unibox-main">
        <slot name="main"></slot>
      </li>
      <li class="unibox-end">
        <slot name="end"></slot>
      </li>
    </menu>
    `
  }
}

