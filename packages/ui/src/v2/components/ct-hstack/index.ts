import { CTHStack } from "./ct-hstack.ts";

if (!customElements.get("ct-hstack")) {
  customElements.define("ct-hstack", CTHStack);
}

export { CTHStack };
