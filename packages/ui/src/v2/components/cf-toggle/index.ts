import { CFToggle, ToggleSize, ToggleVariant } from "./cf-toggle.ts";

if (!customElements.get("cf-toggle")) {
  customElements.define("cf-toggle", CFToggle);
}

export { CFToggle };
export type { ToggleSize, ToggleVariant };
