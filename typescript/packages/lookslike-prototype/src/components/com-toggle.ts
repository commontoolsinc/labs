import { LitElement, html, css } from 'lit-element'
import { customElement } from 'lit/decorators.js'

@customElement('com-toggle')
export class ComToggle extends LitElement {
  static styles = css`
    .expander {
    }

    input {
        display: none;
    }

    label {
        display: block;
        cursor: pointer;
        background-color: #f0f0f0;
        border: 1px solid #ccc;
        font-size: .5rem;
        font-family: monospace;
        padding: 0 .5rem;
    }

    input:checked + label + .content {
        display: block;
    }

    .content {
        display: none;
    }
  `;

  render() {
    return html`
        <div class="expander">
            <input type="checkbox" id="toggle">
            <label for="toggle"><slot name="label">Expand</slot></label>
            <div class="content">
                <slot></slot>
            </div>
        </div>
    `;
  }
}
