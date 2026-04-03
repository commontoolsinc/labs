import { ButtonSize, ButtonVariant, CTButton } from "./ct-button.ts";

if (!customElements.get("ct-button")) {
  customElements.define("ct-button", CTButton);
}

export { CTButton };
export type { ButtonSize, ButtonVariant };
