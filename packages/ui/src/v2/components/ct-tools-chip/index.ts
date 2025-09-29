import { CTToolsChip } from "./ct-tools-chip.ts";

if (!customElements.get("ct-tools-chip")) {
  customElements.define("ct-tools-chip", CTToolsChip);
}

export { CTToolsChip };
export type { ToolsChipTool } from "./ct-tools-chip.ts";
