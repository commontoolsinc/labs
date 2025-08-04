/**
 * CT Outliner Component Exports
 */

import { CTOutliner } from "./ct-outliner.ts";
export { CTOutliner };
export type {
  Attachment,
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
export {
  executeKeyboardCommand,
  KeyboardCommands,
} from "./keyboard-commands.ts";

// Auto-register the custom element
if (!customElements.get("ct-outliner")) {
  customElements.define("ct-outliner", CTOutliner);
}
