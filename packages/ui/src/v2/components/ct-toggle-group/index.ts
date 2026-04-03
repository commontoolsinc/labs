import { CTToggleGroup, ToggleGroupType } from "./ct-toggle-group.ts";

if (!customElements.get("ct-toggle-group")) {
  customElements.define("ct-toggle-group", CTToggleGroup);
}

export { CTToggleGroup };
export type { ToggleGroupType };
