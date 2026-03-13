import { html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

export class CTLink extends BaseElement {
  @property({ type: String })
  declare to: string;

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("click", (e: Event) => {
      e.preventDefault();
      this.emit("ct-route-change", { to: this.to });
    });
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}

globalThis.customElements.define("ct-link", CTLink);
