import { ButtonSize, ButtonVariant, CFButton } from "./cf-button.ts";
import type { ColorIntent } from "../theme-context.ts";

if (!customElements.get("cf-button")) {
  customElements.define("cf-button", CFButton);
}

export { CFButton };
export type { ButtonSize, ButtonVariant, ColorIntent };
