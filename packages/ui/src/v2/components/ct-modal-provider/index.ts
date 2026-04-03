import { CTModalProvider } from "./ct-modal-provider.ts";

if (!customElements.get("ct-modal-provider")) {
  customElements.define("ct-modal-provider", CTModalProvider);
}

export { CTModalProvider };
