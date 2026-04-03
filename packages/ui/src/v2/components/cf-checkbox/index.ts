import { CFCheckbox } from "./cf-checkbox.ts";

if (!customElements.get("cf-checkbox")) {
  customElements.define("cf-checkbox", CFCheckbox);
}

export { CFCheckbox };
