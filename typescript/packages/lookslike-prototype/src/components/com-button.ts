import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { base } from "../styles";

const styles = css`
  :host {
    display: inline-block;
  }

  .button {
    display: block;
    font-weight: bold;
  }
`;

@customElement("com-button")
export class ComButton extends LitElement {
  static styles = [base, styles];

  @property({ type: Function }) action = () => {};

  render() {
    return html`<button class="button" @click=${this.action}>
      <slot></slot>
    </button>`;
  }
}
