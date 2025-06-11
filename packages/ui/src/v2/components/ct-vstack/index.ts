import { CTVStack } from "./ct-vstack.ts";

if (!customElements.get("ct-vstack")) {
  customElements.define("ct-vstack", CTVStack);
}

export { CTVStack };
