import { LitElement, html, css } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../styles";

const styles = css`
  :host {
    display: block;
  }

  .layout {
    display: flex;
    flex-direction: column;
  }

  .main {
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--gap);
  }
`;

@customElement("com-chat")
export class ComChat extends LitElement {
  static styles = [base, styles];

  override render() {
    return html`
      <div class="layout">
        <div class="main">
          <slot name="main"></slot>
        </div>
      </div>
    `;
  }
}
