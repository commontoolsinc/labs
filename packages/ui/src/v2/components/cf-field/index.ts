import { CFField } from "./cf-field.ts";

if (!customElements.get("cf-field")) {
  customElements.define("cf-field", CFField);
}

export { CFField };
