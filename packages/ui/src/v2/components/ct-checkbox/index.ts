import { CTCheckbox } from "./ct-checkbox.ts";

if (!customElements.get("ct-checkbox")) {
  customElements.define("ct-checkbox", CTCheckbox);
}

export { CTCheckbox };
