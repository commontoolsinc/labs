import { html, LitElement } from "lit";
import { provide } from "@lit/context";
import { type RouterStore, routerStoreContext } from "../router-context.ts";

export class CTRouterProvider extends LitElement {
  @provide({ context: routerStoreContext })
  store: RouterStore = {
    url: "/",
    setUrl: (url: string) => {
      this.store = { ...this.store, url };
    },
  };

  override render() {
    return html`
      <slot></slot>
    `;
  }
}

globalThis.customElements.define("ct-router-provider", CTRouterProvider);
