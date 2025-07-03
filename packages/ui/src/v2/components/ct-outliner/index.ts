/**
 * CT Outliner Component Exports
 */

import { CTOutliner } from "./ct-outliner.ts";
export { CTOutliner };
export type {
  CharmReference,
  MentionableItem,
  OutlineNode,
  OutlineNodeData,
  OutlineUIState,
  KeyboardContext,
  KeyboardCommand,
  EditingState,
  NodeCreationOptions,
  TreeOperationResult
} from "./types.ts";
export { TreeOperations } from "./tree-operations.ts";
export { KeyboardCommands, executeKeyboardCommand } from "./keyboard-commands.ts";

// Auto-register the custom element
if (!customElements.get("ct-outliner")) {
  customElements.define("ct-outliner", CTOutliner);
}