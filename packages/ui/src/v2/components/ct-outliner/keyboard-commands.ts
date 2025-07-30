import type {
  EditingKeyboardContext,
  KeyboardCommand,
  KeyboardContext,
} from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";

/**
 * Keyboard command implementations for the outliner
 */
export const KeyboardCommands = {
  ArrowUp: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Up moves node up among siblings
        if (ctx.focusedNode) {
          ctx.component.moveNodeUp(ctx.focusedNode);
        }
      } else {
        if (ctx.currentIndex > 0) {
          ctx.component.focusedNode = ctx.allNodes[ctx.currentIndex - 1];
        } else if (ctx.currentIndex === -1 && ctx.allNodes.length > 0) {
          // If nothing is focused, start from the last node
          ctx.component.focusedNode = ctx.allNodes[ctx.allNodes.length - 1];
        }
      }
    },
  },

  ArrowDown: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Down moves node down among siblings
        if (ctx.focusedNode) {
          ctx.component.moveNodeDown(ctx.focusedNode);
        }
      } else {
        if (ctx.currentIndex < ctx.allNodes.length - 1) {
          ctx.component.focusedNode = ctx.allNodes[ctx.currentIndex + 1];
        } else if (ctx.currentIndex === -1 && ctx.allNodes.length > 0) {
          // If nothing is focused, start from the first node
          ctx.component.focusedNode = ctx.allNodes[0];
        }
      }
    },
  },

  ArrowLeft: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Left collapses current node
        if (ctx.focusedNode && ctx.focusedNode.children.length > 0) {
          ctx.component.collapsedNodes.add(ctx.focusedNode);
          ctx.component.requestUpdate();
        }
      } else {
        if (ctx.focusedNode) {
          if (
            ctx.focusedNode.children.length > 0 &&
            !ctx.component.collapsedNodes.has(ctx.focusedNode)
          ) {
            // Collapse node if expanded
            ctx.component.collapsedNodes.add(ctx.focusedNode);
            ctx.component.requestUpdate();
          } else {
            // Move to parent if collapsed or leaf
            const parentNode = TreeOperations.findParentNode(
              ctx.component.tree.root,
              ctx.focusedNode,
            );
            if (parentNode && parentNode !== ctx.component.tree.root) {
              ctx.component.focusedNode = parentNode;
            }
          }
        }
      }
    },
  },

  ArrowRight: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Right expands current node
        if (ctx.focusedNode && ctx.focusedNode.children.length > 0) {
          ctx.component.collapsedNodes.delete(ctx.focusedNode);
          ctx.component.requestUpdate();
        }
      } else {
        if (ctx.focusedNode) {
          if (ctx.focusedNode.children.length > 0) {
            if (ctx.component.collapsedNodes.has(ctx.focusedNode)) {
              // Expand node if collapsed
              ctx.component.collapsedNodes.delete(ctx.focusedNode);
              ctx.component.requestUpdate();
            } else {
              // Move to first child if expanded
              ctx.component.focusedNode = ctx.focusedNode.children[0];
            }
          }
        }
      }
    },
  },

  " ": { // Space key
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNode) {
        ctx.component.startEditing(ctx.focusedNode);
      }
    },
  },

  Delete: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNode) {
        ctx.component.deleteNode(ctx.focusedNode);
      }
    },
  },

  Backspace: {
    execute(ctx: KeyboardContext): void {
      // cmd/ctrl+backspace deletes node even in read mode
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNode) {
        ctx.event.preventDefault();
        ctx.component.deleteNode(ctx.focusedNode);
      }
    },
  },

  Tab: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNode) {
        if (ctx.event.shiftKey) {
          ctx.component.outdentNode(ctx.focusedNode);
        } else {
          ctx.component.indentNode(ctx.focusedNode);
        }
      }
    },
  },

  a: {
    execute(ctx: KeyboardContext): void {
      if (ctx.event.metaKey || ctx.event.ctrlKey) {
        ctx.event.preventDefault();
        // Select all nodes
        // This could be implemented if needed
      }
    },
  },

  c: {
    execute(ctx: KeyboardContext): void {
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNode) {
        // Copy node as markdown
        const nodeMarkdown = TreeOperations.toMarkdown({
          root: TreeOperations.createNode({
            body: "",
            children: [ctx.focusedNode],
          }),
        });
        navigator.clipboard.writeText(nodeMarkdown);
      }
    },
  },

  l: {
    execute(ctx: KeyboardContext): void {
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNode) {
        ctx.event.preventDefault();
        // Toggle checkbox on the focused node using proper transactions
        ctx.component.toggleNodeCheckbox(ctx.focusedNode);
      }
    },
  },

  n: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNode) {
        ctx.component.createNewNodeAfter(ctx.focusedNode);
      }
    },
  },

  Enter: {
    execute(ctx: KeyboardContext): void {
      // cmd/ctrl+enter toggles edit mode
      if (ctx.event.metaKey || ctx.event.ctrlKey) {
        ctx.event.preventDefault();
        if (ctx.focusedNode) {
          ctx.component.toggleEditMode(ctx.focusedNode);
        }
      } else {
        ctx.event.preventDefault();
        if (ctx.focusedNode) {
          if (ctx.event.shiftKey) {
            // Shift+Enter creates a child node
            ctx.component.createChildNode(ctx.focusedNode);
          } else {
            // Enter creates a sibling node
            ctx.component.createNewNodeAfter(ctx.focusedNode);
          }
        }
      }
    },
  },

  "[": {
    execute(ctx: KeyboardContext): void {
      // cmd/ctrl+[ outdents node
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNode) {
        ctx.event.preventDefault();
        ctx.component.outdentNode(ctx.focusedNode);
      }
    },
  },

  "]": {
    execute(ctx: KeyboardContext): void {
      // cmd/ctrl+] indents node
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNode) {
        ctx.event.preventDefault();
        ctx.component.indentNode(ctx.focusedNode);
      }
    },
  },
};

/**
 * Handle typing any regular character to enter edit mode
 * When typing, replace the entire content with the new character
 */
export function handleTypingToEdit(
  key: string,
  context: KeyboardContext,
): boolean {
  // Check if this is a regular typing key (letter, number, punctuation)
  if (
    key.length === 1 && !context.event.ctrlKey && !context.event.metaKey &&
    !context.event.altKey
  ) {
    if (context.focusedNode) {
      // Replace entire content with the typed character
      context.component.startEditingWithInitialText(context.focusedNode, key);
      return true;
    }
  }
  return false;
}

/**
 * Execute a keyboard command based on the key pressed
 */
export function executeKeyboardCommand(
  key: string,
  context: KeyboardContext,
): boolean {
  const command = KeyboardCommands[key as keyof typeof KeyboardCommands];
  if (command) {
    command.execute(context);
    return true;
  }

  // If no specific command, check if it's a typing key
  return handleTypingToEdit(key, context);
}

/**
 * Editing mode keyboard commands
 */
export const EditingKeyboardCommands = {
  ArrowUp: {
    execute(ctx: EditingKeyboardContext): boolean {
      const { textarea, event } = ctx;

      // Check if cursor is at the first line
      const lines = textarea.value.substring(0, textarea.selectionStart).split(
        "\n",
      );
      if (lines.length === 1) {
        event.preventDefault();
        ctx.component.finishEditing();
        // Move focus to previous node
        const allNodes = ctx.component.getAllVisibleNodes();
        const currentIndex = allNodes.indexOf(ctx.editingNode);
        if (currentIndex > 0) {
          ctx.component.focusedNode = allNodes[currentIndex - 1];
        }
        ctx.component.requestUpdate();
        return true;
      }
      return false;
    },
  },

  ArrowDown: {
    execute(ctx: EditingKeyboardContext): boolean {
      const { textarea, event } = ctx;

      // Check if cursor is at the last line
      const textAfterCursor = textarea.value.substring(textarea.selectionStart);
      if (!textAfterCursor.includes("\n")) {
        event.preventDefault();
        ctx.component.finishEditing();
        // Move focus to next node
        const allNodes = ctx.component.getAllVisibleNodes();
        const currentIndex = allNodes.indexOf(ctx.editingNode);
        if (currentIndex < allNodes.length - 1) {
          ctx.component.focusedNode = allNodes[currentIndex + 1];
        }
        ctx.component.requestUpdate();
        return true;
      }
      return false;
    },
  },

  ArrowLeft: {
    execute(ctx: EditingKeyboardContext): boolean {
      const { textarea, event } = ctx;

      // Check if cursor is at the beginning
      if (textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        event.preventDefault();
        ctx.component.finishEditing();
        ctx.component.requestUpdate();
        return true;
      }
      return false;
    },
  },

  ArrowRight: {
    execute(ctx: EditingKeyboardContext): boolean {
      const { textarea, event } = ctx;

      // Check if cursor is at the end
      if (
        textarea.selectionStart === textarea.value.length &&
        textarea.selectionEnd === textarea.value.length
      ) {
        event.preventDefault();
        ctx.component.finishEditing();
        ctx.component.requestUpdate();
        return true;
      }
      return false;
    },
  },

  "[": {
    execute(ctx: EditingKeyboardContext): boolean {
      const { event, textarea } = ctx;

      // cmd/ctrl+[ outdents node even in edit mode
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();

        // Save current editing content and cursor position from textarea
        const currentContent = textarea.value;
        const cursorPosition = textarea.selectionStart;

        // Perform the outdent operation while preserving edit state
        ctx.component.outdentNodeWithEditState(
          ctx.editingNode,
          currentContent,
          cursorPosition,
        );

        return true;
      }
      return false;
    },
  },

  "]": {
    execute(ctx: EditingKeyboardContext): boolean {
      const { event, textarea } = ctx;

      // cmd/ctrl+] indents node even in edit mode
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();

        // Save current editing content and cursor position from textarea
        const currentContent = textarea.value;
        const cursorPosition = textarea.selectionStart;

        // Perform the indent operation while preserving edit state
        ctx.component.indentNodeWithEditState(
          ctx.editingNode,
          currentContent,
          cursorPosition,
        );

        return true;
      }
      return false;
    },
  },

  l: {
    execute(ctx: EditingKeyboardContext): boolean {
      const { event, textarea } = ctx;

      // cmd/ctrl+l toggles checkbox even in edit mode
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();

        // Save current editing content from textarea
        const currentContent = textarea.value;
        
        // Apply checkbox toggle logic inline
        let newContent: string;
        const hasCheckbox = /^\s*\[[ x]?\]\s*/.test(currentContent);
        const isChecked = /^\s*\[x\]\s*/.test(currentContent);
        
        if (hasCheckbox) {
          // Toggle existing checkbox
          if (isChecked) {
            // Checked -> Unchecked (normalize to [ ])
            newContent = currentContent.replace(/^\s*\[x\]\s*/, '[ ] ');
          } else {
            // Unchecked -> Checked
            newContent = currentContent.replace(/^\s*\[[ ]?\]\s*/, '[x] ');
          }
        } else {
          // Add checkbox if none exists
          newContent = '[ ] ' + currentContent;
        }
        
        // Update the textarea with the new content
        textarea.value = newContent;
        
        // Update the component's editing content state
        if ('editingContent' in ctx.component) {
          (ctx.component as any).editingContent = newContent;
        }

        // Trigger input event to ensure proper handling
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        return true;
      }
      return false;
    },
  },
};

/**
 * Execute editing keyboard command
 */
export function executeEditingKeyboardCommand(
  key: string,
  context: EditingKeyboardContext,
): boolean {
  const command =
    EditingKeyboardCommands[key as keyof typeof EditingKeyboardCommands];
  if (command) {
    return command.execute(context);
  }
  return false;
}
