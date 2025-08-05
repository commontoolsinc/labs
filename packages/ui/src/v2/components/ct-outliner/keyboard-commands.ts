import type {
  EditingKeyboardContext,
  KeyboardCommand,
  KeyboardContext,
  PathBasedKeyboardContext,
  PathBasedEditingKeyboardContext,
  PathBasedKeyboardCommand,
} from "./types.ts";
import { getNodeByPath, getNodePath } from "./node-path.ts";
import { TreeOperations } from "./tree-operations.ts";

/**
 * Path-based keyboard command implementations for the outliner
 */
export const PathBasedKeyboardCommands = {
  ArrowUp: {
    execute(ctx: PathBasedKeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Up moves node up among siblings
        if (ctx.focusedNodePath) {
          ctx.component.moveNodeUpByPath(ctx.focusedNodePath);
        }
      } else {
        if (ctx.currentIndex > 0) {
          const prevNode = ctx.allNodes[ctx.currentIndex - 1];
          const prevNodePath = getNodePath(ctx.component.tree, prevNode);
          if (prevNodePath) {
            ctx.component.focusedNodePath = prevNodePath;
          }
        } else if (ctx.currentIndex === -1 && ctx.allNodes.length > 0) {
          // If nothing is focused, start from the last node
          const lastNode = ctx.allNodes[ctx.allNodes.length - 1];
          const lastNodePath = getNodePath(ctx.component.tree, lastNode);
          if (lastNodePath) {
            ctx.component.focusedNodePath = lastNodePath;
          }
        }
      }
    },
  },

  ArrowDown: {
    execute(ctx: PathBasedKeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Down moves node down among siblings
        if (ctx.focusedNodePath) {
          ctx.component.moveNodeDownByPath(ctx.focusedNodePath);
        }
      } else {
        if (ctx.currentIndex < ctx.allNodes.length - 1) {
          const nextNode = ctx.allNodes[ctx.currentIndex + 1];
          const nextNodePath = getNodePath(ctx.component.tree, nextNode);
          if (nextNodePath) {
            ctx.component.focusedNodePath = nextNodePath;
          }
        } else if (ctx.currentIndex === -1 && ctx.allNodes.length > 0) {
          // If nothing is focused, start from the first node
          const firstNode = ctx.allNodes[0];
          const firstNodePath = getNodePath(ctx.component.tree, firstNode);
          if (firstNodePath) {
            ctx.component.focusedNodePath = firstNodePath;
          }
        }
      }
    },
  },

  ArrowLeft: {
    execute(ctx: PathBasedKeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Left collapses current node
        if (ctx.focusedNodePath) {
          const focusedNode = getNodeByPath(ctx.component.tree, ctx.focusedNodePath);
          if (focusedNode && focusedNode.children.length > 0) {
            ctx.component.collapsedNodePaths.add(ctx.focusedNodePath.join(","));
            ctx.component.requestUpdate();
          }
        }
      } else {
        if (ctx.focusedNodePath) {
          const focusedNode = getNodeByPath(ctx.component.tree, ctx.focusedNodePath);
          if (
            focusedNode &&
            focusedNode.children.length > 0 &&
            !ctx.component.collapsedNodePaths.has(ctx.focusedNodePath.join(","))
          ) {
            // Collapse node if expanded
            ctx.component.collapsedNodePaths.add(ctx.focusedNodePath.join(","));
            ctx.component.requestUpdate();
          } else {
            // Move to parent if collapsed or leaf
            if (ctx.focusedNodePath.length > 0) {
              const parentPath = ctx.focusedNodePath.slice(0, -1);
              if (parentPath.length > 0) {
                ctx.component.focusedNodePath = parentPath;
              }
            }
          }
        }
      }
    },
  },

  ArrowRight: {
    execute(ctx: PathBasedKeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Right expands current node
        if (ctx.focusedNodePath) {
          const focusedNode = getNodeByPath(ctx.component.tree, ctx.focusedNodePath);
          if (focusedNode && focusedNode.children.length > 0) {
            ctx.component.collapsedNodePaths.delete(ctx.focusedNodePath.join(","));
            ctx.component.requestUpdate();
          }
        }
      } else {
        if (ctx.focusedNodePath) {
          const focusedNode = getNodeByPath(ctx.component.tree, ctx.focusedNodePath);
          if (focusedNode && focusedNode.children.length > 0) {
            if (ctx.component.collapsedNodePaths.has(ctx.focusedNodePath.join(","))) {
              // Expand node if collapsed
              ctx.component.collapsedNodePaths.delete(ctx.focusedNodePath.join(","));
              ctx.component.requestUpdate();
            } else {
              // Move to first child if expanded
              const firstChildPath = [...ctx.focusedNodePath, 0];
              ctx.component.focusedNodePath = firstChildPath;
            }
          }
        }
      }
    },
  },

  " ": { // Space key
    execute(ctx: PathBasedKeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNodePath) {
        ctx.component.startEditingByPath(ctx.focusedNodePath);
      }
    },
  },

  Delete: {
    execute(ctx: PathBasedKeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNodePath) {
        ctx.component.deleteNodeByPath(ctx.focusedNodePath);
      }
    },
  },

  Backspace: {
    execute(ctx: PathBasedKeyboardContext): void {
      // cmd/ctrl+backspace deletes node even in read mode
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNodePath) {
        ctx.event.preventDefault();
        ctx.component.deleteNodeByPath(ctx.focusedNodePath);
      }
    },
  },

  Tab: {
    execute(ctx: PathBasedKeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNodePath) {
        if (ctx.event.shiftKey) {
          ctx.component.outdentNodeByPath(ctx.focusedNodePath);
        } else {
          ctx.component.indentNodeByPath(ctx.focusedNodePath);
        }
      }
    },
  },

  c: {
    execute(ctx: PathBasedKeyboardContext): void {
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNodePath) {
        const focusedNode = getNodeByPath(ctx.component.tree, ctx.focusedNodePath);
        if (focusedNode) {
          // Copy node as markdown
          const nodeMarkdown = TreeOperations.toMarkdown({
            root: TreeOperations.createNode({
              body: "",
              children: [focusedNode],
            }),
          });
          navigator.clipboard.writeText(nodeMarkdown);
        }
      }
    },
  },

  l: {
    execute(ctx: PathBasedKeyboardContext): void {
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNodePath) {
        ctx.event.preventDefault();
        // Toggle checkbox on the focused node
        ctx.component.toggleNodeCheckboxByPath(ctx.focusedNodePath);
      }
    },
  },

  n: {
    execute(ctx: PathBasedKeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNodePath) {
        ctx.component.createNodeAfterPath(ctx.focusedNodePath, { body: "" });
      }
    },
  },

  Enter: {
    execute(ctx: PathBasedKeyboardContext): void {
      // cmd/ctrl+enter toggles edit mode
      if (ctx.event.metaKey || ctx.event.ctrlKey) {
        ctx.event.preventDefault();
        if (ctx.focusedNodePath) {
          const focusedNode = getNodeByPath(ctx.component.tree, ctx.focusedNodePath);
          if (focusedNode) {
            // Check if we're editing this node
            const isEditingThisNode = ctx.component.editingNodePath &&
              ctx.component.editingNodePath.length === ctx.focusedNodePath.length &&
              ctx.component.editingNodePath.every((val, idx) => val === ctx.focusedNodePath![idx]);

            if (isEditingThisNode) {
              ctx.component.finishEditing();
            } else {
              ctx.component.startEditingByPath(ctx.focusedNodePath);
            }
          }
        }
      } else {
        ctx.event.preventDefault();
        if (ctx.focusedNodePath) {
          if (ctx.event.shiftKey) {
            // Shift+Enter creates a child node
            ctx.component.createChildNodeAtPath(ctx.focusedNodePath, { body: "" });
          } else {
            // Enter creates a sibling node
            ctx.component.createNodeAfterPath(ctx.focusedNodePath, { body: "" });
          }
        }
      }
    },
  },

  "[": {
    execute(ctx: PathBasedKeyboardContext): void {
      // cmd/ctrl+[ outdents node
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNodePath) {
        ctx.event.preventDefault();
        ctx.component.outdentNodeByPath(ctx.focusedNodePath);
      }
    },
  },

  "]": {
    execute(ctx: PathBasedKeyboardContext): void {
      // cmd/ctrl+] indents node
      if ((ctx.event.metaKey || ctx.event.ctrlKey) && ctx.focusedNodePath) {
        ctx.event.preventDefault();
        ctx.component.indentNodeByPath(ctx.focusedNodePath);
      }
    },
  },
};

/**
 * Legacy keyboard command implementations for the outliner
 * @deprecated Use PathBasedKeyboardCommands instead
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
            // Use focusedNode to find parent
            const allNodes = ctx.component.getAllVisibleNodes();
            const currentIndex = allNodes.indexOf(ctx.focusedNode);
            if (currentIndex > 0) {
              // Find parent by looking backwards in visible nodes
              const parentNode = allNodes[currentIndex - 1];
              if (parentNode) {
                ctx.component.focusedNode = parentNode;
              }
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
 * Handle typing any regular character to enter edit mode - path-based version
 * When typing, replace the entire content with the new character
 */
export function handlePathBasedTypingToEdit(
  key: string,
  context: PathBasedKeyboardContext,
): boolean {
  // Check if this is a regular typing key (letter, number, punctuation)
  if (
    key.length === 1 && !context.event.ctrlKey && !context.event.metaKey &&
    !context.event.altKey
  ) {
    if (context.focusedNodePath) {
      // Replace entire content with the typed character
      context.component.startEditingByPath(context.focusedNodePath, key);
      return true;
    }
  }
  return false;
}

/**
 * Handle typing any regular character to enter edit mode
 * When typing, replace the entire content with the new character
 * @deprecated Use handlePathBasedTypingToEdit instead
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
      const nodePath = getNodePath(context.component.tree, context.focusedNode);
      if (nodePath && "startEditingByPath" in context.component) {
        (context.component as any).startEditingByPath(nodePath, key);
        return true;
      }
    }
  }
  return false;
}

/**
 * Execute a path-based keyboard command based on the key pressed
 */
export function executePathBasedKeyboardCommand(
  key: string,
  context: PathBasedKeyboardContext,
): boolean {
  const command = PathBasedKeyboardCommands[key as keyof typeof PathBasedKeyboardCommands];
  if (command) {
    command.execute(context);
    return true;
  }

  // If no specific command, check if it's a typing key
  return handlePathBasedTypingToEdit(key, context);
}

/**
 * Execute a keyboard command based on the key pressed
 * @deprecated Use executePathBasedKeyboardCommand instead
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
            newContent = currentContent.replace(/^\s*\[x\]\s*/, "[ ] ");
          } else {
            // Unchecked -> Checked
            newContent = currentContent.replace(/^\s*\[[ ]?\]\s*/, "[x] ");
          }
        } else {
          // Add checkbox if none exists
          newContent = "[ ] " + currentContent;
        }

        // Update the textarea with the new content
        textarea.value = newContent;

        // Update the component's editing content state
        if ("editingContent" in ctx.component) {
          (ctx.component as any).editingContent = newContent;
        }

        // Trigger input event to ensure proper handling
        textarea.dispatchEvent(new Event("input", { bubbles: true }));

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
