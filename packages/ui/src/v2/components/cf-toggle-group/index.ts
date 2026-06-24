import { CFToggleGroup } from "./cf-toggle-group.ts";

import { ToggleGroupType } from "./cf-toggle-group.ts";

if (!customElements.get("cf-toggle-group")) {
  customElements.define("cf-toggle-group", CFToggleGroup);
}

export type { CFToggleGroup as CFToggleGroupElement } from "./cf-toggle-group.ts";

export { CFToggleGroup };
export type { ToggleGroupType };
