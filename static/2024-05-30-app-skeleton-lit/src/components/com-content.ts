import {LitElement, html, css} from 'lit-element'
import {customElement} from 'lit/decorators.js'
import {base} from '../styles'

const styles = css`
  :host {
    display: block;
    container-type: inline-size;
    height: 100cqh;
  }

  .container {
    max-width: var(--content-width);
    display: block;
    height: 100cqh;
    container-type: inline-size;
    margin: 0 auto;
    padding-left: var(--gap);
    padding-right: var(--gap);
  }
`

@customElement('com-content')
export class ComAppGrid extends LitElement {
  static styles = [base, styles]

  render() {
    return html`
      <div class="container">
        <slot></slot>
      </div>
    `
  }
}

