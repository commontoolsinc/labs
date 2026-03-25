import { CFModalProvider } from "./cf-modal-provider.ts";

if (!customElements.get("cf-modal-provider")) {
  customElements.define("cf-modal-provider", CFModalProvider);
}

export { CFModalProvider };
