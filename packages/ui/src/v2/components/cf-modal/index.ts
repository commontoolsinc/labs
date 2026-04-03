import { CFModal } from "./cf-modal.ts";

if (!customElements.get("cf-modal")) {
  customElements.define("cf-modal", CFModal);
}

export { CFModal };
export { modalStyles } from "./styles.ts";
