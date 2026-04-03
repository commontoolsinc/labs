import { CFToolsChip } from "./cf-tools-chip.ts";

if (!customElements.get("cf-tools-chip")) {
  customElements.define("cf-tools-chip", CFToolsChip);
}

export { CFToolsChip };
export type { ToolsChipTool } from "./cf-tools-chip.ts";
