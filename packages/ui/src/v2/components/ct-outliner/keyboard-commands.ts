import type { KeyboardCommand, KeyboardContext, EditingKeyboardContext } from "./types.ts";

/**
 * Keyboard command implementations for the outliner
 */
export const KeyboardCommands = {
  ArrowUp: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Up moves node up among siblings
        ctx.component.moveNodeUp(ctx.focusedNodeId);
      } else {
        if (ctx.currentIndex > 0) {
          ctx.component.focusedNodeId = ctx.allNodes[ctx.currentIndex - 1].id;
        } else if (ctx.currentIndex === -1 && ctx.allNodes.length > 0) {
          // If nothing is focused, start from the last node
          ctx.component.focusedNodeId = ctx.allNodes[ctx.allNodes.length - 1].id;
        }
      }
    }
  },

  ArrowDown: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Down moves node down among siblings
        ctx.component.moveNodeDown(ctx.focusedNodeId);
      } else {
        if (ctx.currentIndex < ctx.allNodes.length - 1) {
          ctx.component.focusedNodeId = ctx.allNodes[ctx.currentIndex + 1].id;
        } else if (ctx.currentIndex === -1 && ctx.allNodes.length > 0) {
          // If nothing is focused, start from the first node
          ctx.component.focusedNodeId = ctx.allNodes[0].id;
        }
      }
    }
  },

  ArrowLeft: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Left collapses current node
        if (ctx.focusedNodeId) {
          const node = ctx.component.findNode(ctx.focusedNodeId);
          if (node && node.children.length > 0) {
            node.collapsed = true;
            ctx.component.requestUpdate();
          }
        }
      } else {
        if (ctx.focusedNodeId) {
          const node = ctx.component.findNode(ctx.focusedNodeId);
          if (node) {
            if (node.children.length > 0 && !node.collapsed) {
              // Collapse node if expanded
              node.collapsed = true;
              ctx.component.requestUpdate();
            } else {
              // Move to parent if collapsed or leaf
              const parentNode = ctx.component.findParentNode(ctx.focusedNodeId);
              if (parentNode) {
                ctx.component.focusedNodeId = parentNode.id;
              }
            }
          }
        }
      }
    }
  },

  ArrowRight: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.event.altKey) {
        // Alt+Right expands current node
        if (ctx.focusedNodeId) {
          const node = ctx.component.findNode(ctx.focusedNodeId);
          if (node && node.children.length > 0) {
            node.collapsed = false;
            ctx.component.requestUpdate();
          }
        }
      } else {
        if (ctx.focusedNodeId) {
          const node = ctx.component.findNode(ctx.focusedNodeId);
          if (node) {
            if (node.children.length > 0) {
              if (node.collapsed) {
                // Expand node if collapsed
                node.collapsed = false;
                ctx.component.requestUpdate();
              } else {
                // Move to first child if expanded
                ctx.component.focusedNodeId = node.children[0].id;
              }
            }
          }
        }
      }
    }
  },

  Home: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.allNodes.length > 0) {
        ctx.component.focusedNodeId = ctx.allNodes[0].id;
      }
    }
  },

  End: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.allNodes.length > 0) {
        ctx.component.focusedNodeId = ctx.allNodes[ctx.allNodes.length - 1].id;
      }
    }
  },

  Enter: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNodeId) {
        if (ctx.event.shiftKey) {
          // Shift+Enter creates new child node
          ctx.component.createChildNode(ctx.focusedNodeId);
        } else if (ctx.event.metaKey || ctx.event.ctrlKey) {
          // Cmd/Ctrl+Enter starts editing
          ctx.component.startEditing(ctx.focusedNodeId);
        } else if (ctx.event.altKey) {
          // Alt+Enter creates new child node (keeping this for compatibility)
          ctx.component.createChildNode(ctx.focusedNodeId);
        } else {
          // Enter creates new sibling node below current
          ctx.component.createNewNodeAfter(ctx.focusedNodeId);
        }
      }
    }
  },

  Backspace: {
    execute(ctx: KeyboardContext): void {
      // Only delete nodes when Cmd/Ctrl is held down
      if (ctx.event.metaKey || ctx.event.ctrlKey) {
        ctx.event.preventDefault();
        if (ctx.focusedNodeId) {
          ctx.component.deleteNode(ctx.focusedNodeId);
        }
      }
    }
  },

  Delete: {
    execute(ctx: KeyboardContext): void {
      // Only delete nodes when Cmd/Ctrl is held down
      if (ctx.event.metaKey || ctx.event.ctrlKey) {
        ctx.event.preventDefault();
        if (ctx.focusedNodeId) {
          ctx.component.deleteNode(ctx.focusedNodeId);
        }
      }
    }
  },

  Tab: {
    execute(ctx: KeyboardContext): void {
      ctx.event.preventDefault();
      if (ctx.focusedNodeId) {
        if (ctx.event.shiftKey) {
          ctx.component.outdentNode(ctx.focusedNodeId);
        } else {
          ctx.component.indentNode(ctx.focusedNodeId);
        }
      }
    }
  },

  Space: {
    execute(ctx: KeyboardContext): void {
      // Space toggles expand/collapse on parent nodes
      ctx.event.preventDefault();
      if (ctx.focusedNodeId) {
        const node = ctx.component.findNode(ctx.focusedNodeId);
        if (node && node.children.length > 0) {
          node.collapsed = !node.collapsed;
          ctx.component.requestUpdate();
        }
      }
    }
  },

  "[": {
    execute(ctx: KeyboardContext): void {
      if (ctx.event.ctrlKey || ctx.event.metaKey) {
        ctx.event.preventDefault();
        if (ctx.focusedNodeId) {
          ctx.component.outdentNode(ctx.focusedNodeId);
        }
      }
    }
  },

  "]": {
    execute(ctx: KeyboardContext): void {
      if (ctx.event.ctrlKey || ctx.event.metaKey) {
        ctx.event.preventDefault();
        if (ctx.focusedNodeId) {
          ctx.component.indentNode(ctx.focusedNodeId);
        }
      }
    }
  }
} satisfies Record<string, KeyboardCommand>;

/**
 * Keyboard commands for editing mode
 */
export const EditingKeyboardCommands = {
  "[": {
    execute(ctx: EditingKeyboardContext): void {
      if (ctx.event.ctrlKey || ctx.event.metaKey) {
        ctx.event.preventDefault();
        ctx.component.handleIndentation(true); // outdent
      }
    }
  },
  
  "]": {
    execute(ctx: EditingKeyboardContext): void {
      if (ctx.event.ctrlKey || ctx.event.metaKey) {
        ctx.event.preventDefault();
        ctx.component.handleIndentation(false); // indent
      }
    }
  }
} satisfies Record<string, { execute(ctx: EditingKeyboardContext): void }>;

/**
 * Check if a key is a printable character
 */
export function isPrintableCharacter(event: KeyboardEvent): boolean {
  const key = event.key;
  
  // Skip if any modifier keys are pressed (except shift for capitals)
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  
  // Check if it's a single printable character
  return key.length === 1 && !event.ctrlKey && !event.metaKey;
}

/**
 * Execute a keyboard command if it exists
 */
export function executeKeyboardCommand(
  key: string, 
  context: KeyboardContext
): boolean {
  const command = KeyboardCommands[key as keyof typeof KeyboardCommands];
  if (command) {
    command.execute(context);
    return true;
  }
  
  // If no command found and it's a printable character, start editing
  if (isPrintableCharacter(context.event) && context.focusedNodeId) {
    context.event.preventDefault();
    context.component.startEditing(context.focusedNodeId);
    
    // After starting edit mode, insert the typed character
    setTimeout(() => {
      const editor = context.component.shadowRoot?.querySelector(
        `#editor-${context.focusedNodeId}`
      ) as HTMLTextAreaElement;
      if (editor) {
        editor.value = key;
        editor.setSelectionRange(1, 1);
        context.component.editingContent = key;
      }
    }, 0);
    
    return true;
  }
  
  return false;
}

/**
 * Execute an editing mode keyboard command if it exists
 */
export function executeEditingKeyboardCommand(
  key: string,
  context: EditingKeyboardContext
): boolean {
  const command = EditingKeyboardCommands[key as keyof typeof EditingKeyboardCommands];
  if (command) {
    command.execute(context);
    return true;
  }
  return false;
}