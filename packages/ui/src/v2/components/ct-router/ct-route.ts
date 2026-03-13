import { html, LitElement } from "lit";
import { consume } from "@lit/context";
import { type RouterStore, routerStoreContext } from "../router-context.ts";

export class CTRoute extends LitElement {
  @consume({ context: routerStoreContext, subscribe: true })
  store!: RouterStore;

  override render() {
    return html`
      <p>Current: ${this.store.url}</p>
      <button @click="${() => this.store.setUrl("https://api.example.com/v2")}">
        Set API URL
      </button>
    `;
  }
}

globalThis.customElements.define("ct-route", CTRoute);
