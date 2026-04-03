import { CTChevronButton } from "./ct-chevron-button.ts";

if (!customElements.get("ct-chevron-button")) {
  customElements.define("ct-chevron-button", CTChevronButton);
}

export { CTChevronButton };
