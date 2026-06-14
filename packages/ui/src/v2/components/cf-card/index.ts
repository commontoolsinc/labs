import { CFCard } from "./cf-card.ts";

if (!customElements.get("cf-card")) {
  customElements.define("cf-card", CFCard);
}

export { CFCard };
