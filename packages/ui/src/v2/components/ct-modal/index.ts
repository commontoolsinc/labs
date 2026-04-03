import { CTModal } from "./ct-modal.ts";

if (!customElements.get("ct-modal")) {
  customElements.define("ct-modal", CTModal);
}

export { CTModal };
export { modalStyles } from "./styles.ts";
