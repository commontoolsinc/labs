import { CFToggleGroup, ToggleGroupType } from "./cf-toggle-group.ts";

if (!customElements.get("cf-toggle-group")) {
  customElements.define("cf-toggle-group", CFToggleGroup);
}

export { CFToggleGroup };
export type { ToggleGroupType };
