import { CFVStack } from "./cf-vstack.ts";

if (!customElements.get("cf-vstack")) {
  customElements.define("cf-vstack", CFVStack);
}

export { CFVStack };
