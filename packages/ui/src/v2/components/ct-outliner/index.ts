/**
 * CT Outliner Component Exports
 */

import { CTOutliner } from "./ct-outliner.ts";
export { CTOutliner };
export type {
  CharmReference,
  MentionableItem,
  KeyboardContext,
  KeyboardCommand,
  EditingState,
  Tree,
  Node,
  Block,
  Attachment,
  BlockCreationOptions,
  NodeCreationOptions
} from "./types.ts";
export { TreeOperations } from "./tree-operations.ts";
// Legacy TreeOperations file and MigrationBridge removed - using TreeOperations exclusively
export { KeyboardCommands, executeKeyboardCommand } from "./keyboard-commands.ts";

// Auto-register the custom element
if (!customElements.get("ct-outliner")) {
  customElements.define("ct-outliner", CTOutliner);
}