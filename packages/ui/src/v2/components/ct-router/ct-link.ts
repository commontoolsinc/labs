import { html, LitElement } from "lit";
import { consume } from "@lit/context";
import { type RouterStore, routerStoreContext } from "../router-context.ts";
import { property } from "lit/decorators.js";

export class CTLink extends LitElement {
  @consume({ context: routerStoreContext, subscribe: true })
  @property({ attribute: false })
  declare store: RouterStore;

  @property({ type: String })
  declare to: string;

  override render() {
    return html`
      <button @click="${() => this.store?.setUrl(this.to)}">
        Navigate to: ${this.to}
      </button>
    `;
  }
}

globalThis.customElements.define("ct-link", CTLink);
