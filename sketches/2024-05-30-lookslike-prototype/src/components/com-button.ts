import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
  :host {
    display: inline-block;
  }

  .button {
    --color-button: var(--color-green);
    --color-button-text: var(--color-green-2);
    --height: calc(var(--unit) * 11);
    appearance: none;
    background-color: var(--color-button);
    border: 0;
    border-radius: calc(var(--height) / 2);
    color: var(--color-button-text);
    display: block;
    font-size: var(--body-size);
    font-weight: bold;
    height: var(--height);
    line-height: var(--height);
    padding: 0 calc(var(--unit) * 5);
  }
`

@customElement('com-button')
export class ComButton extends LitElement {
  static styles = [base, styles]

  render() {
    return html`<button class="button"><slot></slot></button>`
  }
}
