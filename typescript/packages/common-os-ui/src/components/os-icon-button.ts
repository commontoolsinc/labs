import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-icon-button")
export class OsIconButton extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
        background-color: var(--bg-3);
        border-radius: var(--u-radius);
        width: var(--u-min-touch-size);
        height: var(--u-min-touch-size);
      }
    `,
  ];

  override render() {
    return html`<slot></slot> `;
  }
}
