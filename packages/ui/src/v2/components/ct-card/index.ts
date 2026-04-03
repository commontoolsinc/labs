import { CTCard } from "./ct-card.ts";

if (!customElements.get("ct-card")) {
  customElements.define("ct-card", CTCard);
}

export { CTCard };
