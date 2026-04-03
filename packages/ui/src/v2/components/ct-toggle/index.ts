import { CTToggle, ToggleSize, ToggleVariant } from "./ct-toggle.ts";

if (!customElements.get("ct-toggle")) {
  customElements.define("ct-toggle", CTToggle);
}

export { CTToggle };
export type { ToggleSize, ToggleVariant };
