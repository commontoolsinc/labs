/**
 * CT Outliner Component Exports
 */

import { CTOutliner } from "./ct-outliner.ts";
export { CTOutliner };
export type {
  Attachment,
  CharmReference,
  EditingKeyboardContext,
  EditingState,
  KeyboardCommand,
  KeyboardContext,
  MentionableItem,
  MutableNode,
  MutableTree,
  Node,
  NodeCreationOptions,
  OperationResult, // Deprecated - kept for backward compatibility
  OutlinerOperations,
  Tree,
} from "./types.ts";
export { TreeOperations } from "./tree-operations.ts";
export { NodeUtils } from "./node-utils.ts";
export { EventUtils } from "./event-utils.ts";
export { FocusUtils } from "./focus-utils.ts";
// Legacy TreeOperations file and MigrationBridge removed - using TreeOperations exclusively
export {
  executeKeyboardCommand,
  KeyboardCommands,
} from "./keyboard-commands.ts";

// Auto-register the custom element
if (!customElements.get("ct-outliner")) {
  customElements.define("ct-outliner", CTOutliner);
}
