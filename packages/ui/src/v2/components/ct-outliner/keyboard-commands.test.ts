import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  EditingKeyboardCommands,
  executeKeyboardCommand,
  handleTypingToEdit,
  KeyboardCommands,
} from "./keyboard-commands.ts";
import { CTOutliner } from "./ct-outliner.ts";
import {
  createKeyboardContext,
  createMockKeyboardEvent,
  createMockTextarea,
  createMockTreeCell,
  createNestedTestTree,
  setupMockOutliner,
} from "./test-utils.ts";
import type { KeyboardContext } from "./types.ts";

describe("Keyboard Commands", () => {
  let outliner: CTOutliner;

  async function setupOutliner() {
    const setup = await setupMockOutliner();
    outliner = setup.outliner;
    return setup;
  }

  describe("Basic Commands", () => {
    it("should handle Enter key to create new node", async () => {
      await setupOutliner();
      const initialChildCount = outliner.tree.root.children.length;

      const event = createMockKeyboardEvent("Enter");
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.Enter.execute(context);

      expect(outliner.tree.root.children.length).toBe(initialChildCount + 1);
    });

    it("should handle Shift+Enter to create child node", async () => {
      await setupOutliner();
      const parentNode = outliner.focusedNode!;
      const initialChildCount = parentNode.children.length;

      const event = createMockKeyboardEvent("Enter", { shiftKey: true });
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.Enter.execute(context);

      expect(parentNode.children.length).toBe(initialChildCount + 1);
    });

    it("should handle cmd/ctrl+Enter to toggle edit mode", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;

      const event = createMockKeyboardEvent("Enter", { metaKey: true });
      const context = createKeyboardContext(event, outliner);

      // Should start editing
      KeyboardCommands.Enter.execute(context);
      expect(outliner.testAPI.editingNode).toBe(node);

      // Should stop editing
      KeyboardCommands.Enter.execute(context);
      expect(outliner.testAPI.editingNode).toBe(null);
    });

    it("should exit edit mode with cmd/ctrl+Enter when already editing", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;
      const initialNodeCount = outliner.tree.root.children.length;

      // Start editing first
      outliner.startEditing(node);
      expect(outliner.testAPI.editingNode).toBe(node);

      // Simulate the editing keyboard handler behavior for cmd/ctrl+Enter
      // This tests the actual flow when in edit mode
      const mockTextarea = {
        selectionStart: 0,
        selectionEnd: 0,
        value: "test content",
      } as HTMLTextAreaElement;

      const event = createMockKeyboardEvent("Enter", { metaKey: true });
      Object.defineProperty(event, "target", { value: mockTextarea });

      // Call the editing keyboard handler directly
      outliner.testAPI.handleNormalEditorKeyDown(event);

      // Should exit edit mode
      expect(outliner.testAPI.editingNode).toBe(null);
      // Should NOT create a new node
      expect(outliner.tree.root.children.length).toBe(initialNodeCount);
    });

    it("should handle Space key to start editing", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;

      const event = createMockKeyboardEvent(" ");
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands[" "].execute(context);

      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe(node.body);
    });

    it("should handle Delete key to delete node", async () => {
      await setupOutliner();
      const nodeToDelete = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];

      const event = createMockKeyboardEvent("Delete");
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.Delete.execute(context);

      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0]).toBe(secondNode);
    });

    it("should handle cmd/ctrl+Backspace to delete node", async () => {
      await setupOutliner();
      const nodeToDelete = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];

      const event = createMockKeyboardEvent("Backspace", { metaKey: true });
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.Backspace.execute(context);

      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0]).toBe(secondNode);
    });

    it("should not delete on regular Backspace without modifiers", async () => {
      await setupOutliner();
      const initialChildCount = outliner.tree.root.children.length;

      const event = createMockKeyboardEvent("Backspace");
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.Backspace.execute(context);

      // Should not delete
      expect(outliner.tree.root.children.length).toBe(initialChildCount);
    });
  });

  describe("Navigation Commands", () => {
    it("should handle Tab key for indentation", async () => {
      await setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];
      outliner.focusedNode = secondNode;

      const event = createMockKeyboardEvent("Tab");
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.Tab.execute(context);

      expect(outliner.tree.root.children.length).toBe(1);
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);
    });

    it("should handle Shift+Tab for outdentation", async () => {
      await setupOutliner();
      // Setup nested structure first
      const tree = {
        root: {
          body: "",
          children: [{
            body: "Parent",
            children: [{
              body: "Child",
              children: [],
              attachments: [],
            }],
            attachments: [],
          }],
          attachments: [],
        },
      };
      const treeCell = await createMockTreeCell(tree);
      outliner.value = treeCell;
      const childNode = tree.root.children[0].children[0];
      outliner.focusedNode = childNode;

      const event = createMockKeyboardEvent("Tab", { shiftKey: true });
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.Tab.execute(context);

      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[1]).toBe(childNode);
    });

    it("should handle arrow key navigation", async () => {
      await setupOutliner();
      const firstNode = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];
      outliner.focusedNode = firstNode;

      const event = createMockKeyboardEvent("ArrowDown");
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.ArrowDown.execute(context);

      expect(outliner.focusedNode).toBe(secondNode);
    });

    it("should handle cmd/ctrl+] for indentation", async () => {
      await setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];
      outliner.focusedNode = secondNode;

      const event = createMockKeyboardEvent("]", { metaKey: true });
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands["]"].execute(context);

      expect(outliner.tree.root.children.length).toBe(1);
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);
    });

    it("should handle cmd/ctrl+[ for outdentation", async () => {
      await setupOutliner();
      // Setup nested structure first
      const tree = {
        root: {
          body: "",
          children: [{
            body: "Parent",
            children: [{
              body: "Child",
              children: [],
              attachments: [],
            }],
            attachments: [],
          }],
          attachments: [],
        },
      };
      const treeCell = await createMockTreeCell(tree);
      outliner.value = treeCell;
      const childNode = tree.root.children[0].children[0];
      outliner.focusedNode = childNode;

      const event = createMockKeyboardEvent("[", { metaKey: true });
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands["["].execute(context);

      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[1]).toBe(childNode);
    });

    it("should not indent/outdent without modifiers", async () => {
      await setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const initialStructure = JSON.stringify(outliner.tree);

      // Test ] without modifiers
      const event1 = createMockKeyboardEvent("]");
      const context1 = createKeyboardContext(event1, outliner);
      KeyboardCommands["]"].execute(context1);

      // Test [ without modifiers
      const event2 = createMockKeyboardEvent("[");
      const context2 = createKeyboardContext(event2, outliner);
      KeyboardCommands["["].execute(context2);

      // Structure should be unchanged
      expect(JSON.stringify(outliner.tree)).toBe(initialStructure);
    });
  });

  describe("Typing to Edit", () => {
    it("should enter edit mode when typing regular characters", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;

      const event = createMockKeyboardEvent("a");
      const context = createKeyboardContext(event, outliner);

      const handled = handleTypingToEdit("a", context);

      expect(handled).toBe(true);
      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe("a");
    });

    it("should not enter edit mode for modifier keys", async () => {
      await setupOutliner();

      const event = createMockKeyboardEvent("a", { ctrlKey: true });
      const context = createKeyboardContext(event, outliner);

      const handled = handleTypingToEdit("a", context);

      expect(handled).toBe(false);
      expect(outliner.testAPI.editingNode).toBe(null);
    });

    it("should not enter edit mode for special keys", async () => {
      await setupOutliner();

      const event = createMockKeyboardEvent("Enter");
      const context = createKeyboardContext(event, outliner);

      const handled = handleTypingToEdit("Enter", context);

      expect(handled).toBe(false);
      expect(outliner.testAPI.editingNode).toBe(null);
    });

    it("should overwrite existing content when typing", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;
      const originalContent = node.body;

      const event = createMockKeyboardEvent("x");
      const context = createKeyboardContext(event, outliner);

      handleTypingToEdit("x", context);

      expect(outliner.testAPI.editingContent).toBe("x");
      expect(outliner.testAPI.editingContent).not.toBe(originalContent);
    });
  });

  describe("Command Integration", () => {
    it("should execute keyboard commands via executeKeyboardCommand", async () => {
      await setupOutliner();
      const initialChildCount = outliner.tree.root.children.length;

      const event = createMockKeyboardEvent("Enter");
      const context = createKeyboardContext(event, outliner);

      const handled = executeKeyboardCommand("Enter", context);

      expect(handled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(initialChildCount + 1);
    });

    it("should fall back to typing handler for unknown keys", async () => {
      await setupOutliner();
      const node = outliner.focusedNode!;

      const event = createMockKeyboardEvent("z");
      const context = createKeyboardContext(event, outliner);

      const handled = executeKeyboardCommand("z", context);

      expect(handled).toBe(true);
      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe("z");
    });

    it("should return false for non-actionable keys", async () => {
      await setupOutliner();

      const event = createMockKeyboardEvent("Shift");
      const context = createKeyboardContext(event, outliner);

      const handled = executeKeyboardCommand("Shift", context);

      expect(handled).toBe(false);
    });

    it("should handle cmd/ctrl+[ and ] in edit mode", async () => {
      await setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];

      // Start editing
      outliner.startEditing(secondNode);
      expect(outliner.testAPI.editingNode).toBe(secondNode);

      // Test indent in edit mode
      const mockTextarea = createMockTextarea("test content");

      const indentEvent = createMockKeyboardEvent("]", { metaKey: true });
      Object.defineProperty(indentEvent, "target", { value: mockTextarea });

      const indentContext = {
        event: indentEvent,
        component: outliner,
        editingNode: secondNode,
        editingContent: "test content",
        textarea: mockTextarea,
      };

      const indentHandled = EditingKeyboardCommands["]"].execute(indentContext);

      expect(indentHandled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(1);
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);

      // Test outdent in edit mode
      const outdentEvent = createMockKeyboardEvent("[", { metaKey: true });
      Object.defineProperty(outdentEvent, "target", { value: mockTextarea });

      const outdentContext = {
        event: outdentEvent,
        component: outliner,
        editingNode: secondNode,
        editingContent: "test content",
        textarea: mockTextarea,
      };

      const outdentHandled = EditingKeyboardCommands["["].execute(
        outdentContext,
      );

      expect(outdentHandled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(2);
    });

    it("should preserve edit mode after indent/outdent operations", async () => {
      await setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const editingContent = "editing this node";

      // Start editing with some content
      outliner.startEditingWithInitialText(secondNode, editingContent);
      expect(outliner.testAPI.editingNode).toBe(secondNode);
      expect(outliner.testAPI.editingContent).toBe(editingContent);

      // Indent while in edit mode
      const mockTextarea = createMockTextarea(editingContent, 5);

      const indentEvent = createMockKeyboardEvent("]", { metaKey: true });
      Object.defineProperty(indentEvent, "target", { value: mockTextarea });

      const indentContext = {
        event: indentEvent,
        component: outliner,
        editingNode: secondNode,
        editingContent: editingContent,
        textarea: mockTextarea,
      };

      EditingKeyboardCommands["]"].execute(indentContext);

      // Should still be in edit mode after indent
      expect(outliner.testAPI.editingNode).toBe(secondNode);
      expect(outliner.testAPI.editingContent).toBe(editingContent);

      // Outdent while still in edit mode
      const outdentEvent = createMockKeyboardEvent("[", { metaKey: true });
      Object.defineProperty(outdentEvent, "target", { value: mockTextarea });

      const outdentContext = {
        event: outdentEvent,
        component: outliner,
        editingNode: secondNode,
        editingContent: editingContent,
        textarea: mockTextarea,
      };

      EditingKeyboardCommands["["].execute(outdentContext);

      // Should still be in edit mode after outdent
      expect(outliner.testAPI.editingNode).toBe(secondNode);
      expect(outliner.testAPI.editingContent).toBe(editingContent);
    });

    it("should preserve cursor position and content during edit mode indentation", async () => {
      await setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];
      const editingContent = "I am editing this text";
      const cursorPosition = 15; // Position in "editing this text"

      // Start editing
      outliner.startEditingWithInitialText(secondNode, editingContent);

      // Mock textarea with specific cursor position
      const mockTextarea = createMockTextarea(editingContent, cursorPosition);

      // Simulate cmd+] while editing
      const indentEvent = createMockKeyboardEvent("]", { metaKey: true });
      Object.defineProperty(indentEvent, "target", { value: mockTextarea });

      const indentContext = {
        event: indentEvent,
        component: outliner,
        editingNode: secondNode,
        editingContent: editingContent,
        textarea: mockTextarea,
      };

      EditingKeyboardCommands["]"].execute(indentContext);

      // Verify tree structure changed (node was indented)
      expect(outliner.tree.root.children.length).toBe(1);
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);

      // Verify editing state preserved
      expect(outliner.testAPI.editingNode).toBe(secondNode);
      expect(outliner.testAPI.editingContent).toBe(editingContent);
    });
  });

  describe("Edge Cases", () => {
    it("should handle commands when no node is focused", async () => {
      await setupOutliner();
      outliner.focusedNode = null;

      const event = createMockKeyboardEvent("Enter");
      const context = createKeyboardContext(event, outliner);

      // Should not crash
      expect(() => KeyboardCommands.Enter.execute(context)).not.toThrow();
    });

    it("should handle readonly mode correctly", async () => {
      await setupOutliner();
      outliner.readonly = true;
      const node = outliner.focusedNode!;

      // Regular editing should be blocked
      outliner.startEditing(node);
      expect(outliner.testAPI.editingNode).toBe(null);

      // But cmd+backspace delete should still work
      const event = createMockKeyboardEvent("Backspace", { metaKey: true });
      const context = createKeyboardContext(event, outliner);

      KeyboardCommands.Backspace.execute(context);
      expect(outliner.tree.root.children.length).toBe(1);
    });
  });
});
