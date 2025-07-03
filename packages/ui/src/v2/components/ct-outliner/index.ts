/**
 * CT Outliner Component Exports
 */

import { CTOutliner } from "./ct-outliner.ts";
export { CTOutliner };
export type {
  CharmReference,
  MentionableItem,
  OutlineNode,
  OutlineUIState,
  KeyboardContext,
  KeyboardCommand,
  EditingState,
  NodeCreationOptions,
  LegacyNodeCreationOptions,
  TreeOperationResult,
  Tree,
  Node,
  Block,
  Attachment,
  BlockCreationOptions
} from "./types.ts";
export { BlockOperations } from "./block-operations.ts";
// TreeOperations and MigrationBridge removed - using BlockOperations exclusively
export { KeyboardCommands, executeKeyboardCommand } from "./keyboard-commands.ts";

// Auto-register the custom element
if (!customElements.get("ct-outliner")) {
  customElements.define("ct-outliner", CTOutliner);
}