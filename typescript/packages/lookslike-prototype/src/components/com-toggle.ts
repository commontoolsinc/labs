import { LitElement, html, css } from "lit-element";
import { customElement } from "lit/decorators.js";

@customElement("com-toggle")
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
      font-size: 0.5rem;
      line-height: 0.5rem;
      padding: 0.25rem;
      font-family: monospace;
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
        <input type="checkbox" id="toggle" />
        <label for="toggle"><slot name="label">▶ toggle</slot></label>
        <div class="content">
          <slot></slot>
        </div>
      </div>
    `;
  }
}
