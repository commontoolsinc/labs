import { ButtonSize, ButtonVariant, CFButton } from "./cf-button.ts";

if (!customElements.get("cf-button")) {
  customElements.define("cf-button", CFButton);
}

export { CFButton };
export type { ButtonSize, ButtonVariant };
