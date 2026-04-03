import { CFHStack } from "./cf-hstack.ts";

if (!customElements.get("cf-hstack")) {
  customElements.define("cf-hstack", CFHStack);
}

export { CFHStack };
