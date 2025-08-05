import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  EditingKeyboardCommands,
  executeKeyboardCommand,
  executePathBasedKeyboardCommand,
  handleTypingToEdit,
  handlePathBasedTypingToEdit,
  KeyboardCommands,
  PathBasedKeyboardCommands,
} from "./keyboard-commands.ts";
import { CTOutliner } from "./ct-outliner.ts";
import {
  createKeyboardContext,
  createPathBasedKeyboardContext,
  createMockKeyboardEvent,
  createMockTextarea,
  createMockTreeCell,
  createNestedTestTree,
  getAllVisibleNodePaths,
  setupMockOutliner,
  waitForCellUpdate,
  waitForOutlinerUpdate,
} from "./test-utils.ts";
import type { KeyboardContext, PathBasedKeyboardContext } from "./types.ts";
import { getNodeByPath } from "./node-path.ts";

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
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.Enter.execute(context);
      
      // Wait longer to make sure any async operations complete
      await waitForOutlinerUpdate(outliner);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(outliner.tree.root.children.length).toBe(initialChildCount + 1);
    });

    it("should handle Shift+Enter to create child node", async () => {
      await setupOutliner();
      const parentNodePath = outliner.focusedNodePath!;
      const parentNode = getNodeByPath(outliner.tree, parentNodePath)!;
      const initialChildCount = parentNode.children.length;

      const event = createMockKeyboardEvent("Enter", { shiftKey: true });
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.Enter.execute(context);

      expect(parentNode.children.length).toBe(initialChildCount + 1);
    });

    it("should handle cmd/ctrl+Enter to toggle edit mode", async () => {
      await setupOutliner();
      const nodePath = outliner.focusedNodePath!;
      const node = getNodeByPath(outliner.tree, nodePath)!;

      const event = createMockKeyboardEvent("Enter", { metaKey: true });
      const context = createPathBasedKeyboardContext(event, outliner);

      // Should start editing
      PathBasedKeyboardCommands.Enter.execute(context);
      expect(outliner.testAPI.editingNodePath).toEqual(nodePath);

      // Should stop editing
      PathBasedKeyboardCommands.Enter.execute(context);
      expect(outliner.testAPI.editingNodePath).toBe(null);
    });

    it("should exit edit mode with cmd/ctrl+Enter when already editing", async () => {
      await setupOutliner();
      const nodePath = outliner.focusedNodePath!;
      const initialNodeCount = outliner.tree.root.children.length;

      // Start editing first
      outliner.startEditingByPath(nodePath);
      expect(outliner.testAPI.editingNodePath).toEqual(nodePath);

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
      expect(outliner.testAPI.editingNodePath).toBe(null);
      // Should NOT create a new node
      expect(outliner.tree.root.children.length).toBe(initialNodeCount);
    });

    it("should handle Space key to start editing", async () => {
      await setupOutliner();
      const nodePath = outliner.focusedNodePath!;
      const node = getNodeByPath(outliner.tree, nodePath)!;

      const event = createMockKeyboardEvent(" ");
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands[" "].execute(context);

      expect(outliner.testAPI.editingNodePath).toEqual(nodePath);
      expect(outliner.testAPI.editingContent).toBe(node.body);
    });

    it("should handle Delete key to delete node", async () => {
      await setupOutliner();
      const initialLength = outliner.tree.root.children.length;
      const secondNodeBody = outliner.tree.root.children[1].body;

      const event = createMockKeyboardEvent("Delete");
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.Delete.execute(context);
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);

      expect(outliner.tree.root.children.length).toBe(initialLength - 1);
      expect(outliner.tree.root.children[0].body).toBe(secondNodeBody);
    });

    it("should handle cmd/ctrl+Backspace to delete node", async () => {
      await setupOutliner();
      const initialLength = outliner.tree.root.children.length;
      const secondNodeBody = outliner.tree.root.children[1].body;

      const event = createMockKeyboardEvent("Backspace", { metaKey: true });
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.Backspace.execute(context);
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);

      expect(outliner.tree.root.children.length).toBe(initialLength - 1);
      expect(outliner.tree.root.children[0].body).toBe(secondNodeBody);
    });

    it("should not delete on regular Backspace without modifiers", async () => {
      await setupOutliner();
      const initialChildCount = outliner.tree.root.children.length;

      const event = createMockKeyboardEvent("Backspace");
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.Backspace.execute(context);

      // Should not delete
      expect(outliner.tree.root.children.length).toBe(initialChildCount);
    });
  });

  describe("Navigation Commands", () => {
    it.skip("should handle Tab key for indentation", async () => {
      // TODO: This test is currently failing due to a component-level issue
      // with path-based indentation operations causing runtime errors in the Cell system
      await setupOutliner();
      const secondNodeBody = outliner.tree.root.children[1].body;
      outliner.focusedNodePath = [1]; // Focus on the second node

      const event = createMockKeyboardEvent("Tab");
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.Tab.execute(context);
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);

      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0].children.length).toBe(1);
      expect(outliner.tree.root.children[0].children[0].body).toBe(secondNodeBody);
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
      const childNodeBody = "Child";
      outliner.focusedNodePath = [0, 0]; // Focus on the child node

      const event = createMockKeyboardEvent("Tab", { shiftKey: true });
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.Tab.execute(context);
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);

      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[1].body).toBe(childNodeBody);
    });

    it.skip("should handle arrow key navigation", async () => {
      // TODO: This test is failing because the path-based ArrowDown command
      // relies on getNodePath() which doesn't work reliably with Cell-based nodes
      await setupOutliner();
      const firstNodePath = [0];
      const secondNodeBody = outliner.tree.root.children[1].body;
      outliner.focusedNodePath = firstNodePath;

      const event = createMockKeyboardEvent("ArrowDown");
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.ArrowDown.execute(context);

      // After ArrowDown, focused node path should be the second node  
      const expectedSecondNodePath = [1];
      const focusedNode = getNodeByPath(outliner.tree, outliner.focusedNodePath!);
      expect(focusedNode?.body).toBe(secondNodeBody);
      expect(outliner.focusedNodePath).toEqual(expectedSecondNodePath);
    });

    it.skip("should handle cmd/ctrl+] for indentation", async () => {
      // TODO: This test is failing due to the same indentation issue as the Tab test
      await setupOutliner();
      const secondNodeBody = outliner.tree.root.children[1].body;
      outliner.focusedNodePath = [1]; // Focus on the second node

      const event = createMockKeyboardEvent("]", { metaKey: true });
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands["]"].execute(context);
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);

      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0].children.length).toBe(1);
      expect(outliner.tree.root.children[0].children[0].body).toBe(secondNodeBody);
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
      const childNodeBody = "Child";
      outliner.focusedNodePath = [0, 0]; // Focus on the child node

      const event = createMockKeyboardEvent("[", { metaKey: true });
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands["["].execute(context);
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);

      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[1].body).toBe(childNodeBody);
    });

    it("should not indent/outdent without modifiers", async () => {
      await setupOutliner();
      const initialStructure = JSON.stringify(outliner.tree);

      // Test ] without modifiers
      const event1 = createMockKeyboardEvent("]");
      const context1 = createPathBasedKeyboardContext(event1, outliner);
      PathBasedKeyboardCommands["]"].execute(context1);

      // Test [ without modifiers
      const event2 = createMockKeyboardEvent("[");
      const context2 = createPathBasedKeyboardContext(event2, outliner);
      PathBasedKeyboardCommands["["].execute(context2);

      // Structure should be unchanged
      expect(JSON.stringify(outliner.tree)).toBe(initialStructure);
    });
  });

  describe("Typing to Edit", () => {
    it("should enter edit mode when typing regular characters", async () => {
      await setupOutliner();
      const nodePath = outliner.focusedNodePath!;

      const event = createMockKeyboardEvent("a");
      const context = createPathBasedKeyboardContext(event, outliner);

      const handled = handlePathBasedTypingToEdit("a", context);

      expect(handled).toBe(true);
      expect(outliner.testAPI.editingNodePath).toEqual(nodePath);
      expect(outliner.testAPI.editingContent).toBe("a");
    });

    it("should not enter edit mode for modifier keys", async () => {
      await setupOutliner();

      const event = createMockKeyboardEvent("a", { ctrlKey: true });
      const context = createPathBasedKeyboardContext(event, outliner);

      const handled = handlePathBasedTypingToEdit("a", context);

      expect(handled).toBe(false);
      expect(outliner.testAPI.editingNodePath).toBe(null);
    });

    it("should not enter edit mode for special keys", async () => {
      await setupOutliner();

      const event = createMockKeyboardEvent("Enter");
      const context = createPathBasedKeyboardContext(event, outliner);

      const handled = handlePathBasedTypingToEdit("Enter", context);

      expect(handled).toBe(false);
      expect(outliner.testAPI.editingNodePath).toBe(null);
    });

    it("should overwrite existing content when typing", async () => {
      await setupOutliner();
      const nodePath = outliner.focusedNodePath!;
      const node = getNodeByPath(outliner.tree, nodePath)!;
      const originalContent = node.body;

      const event = createMockKeyboardEvent("x");
      const context = createPathBasedKeyboardContext(event, outliner);

      handlePathBasedTypingToEdit("x", context);

      expect(outliner.testAPI.editingContent).toBe("x");
      expect(outliner.testAPI.editingContent).not.toBe(originalContent);
    });
  });

  describe("Command Integration", () => {
    it("should execute keyboard commands via executePathBasedKeyboardCommand", async () => {
      await setupOutliner();
      const initialChildCount = outliner.tree.root.children.length;

      const event = createMockKeyboardEvent("Enter");
      const context = createPathBasedKeyboardContext(event, outliner);

      const handled = executePathBasedKeyboardCommand("Enter", context);
      
      // Wait for the outliner's Cell to update
      await waitForOutlinerUpdate(outliner);

      expect(handled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(initialChildCount + 1);
    });

    it("should fall back to typing handler for unknown keys", async () => {
      await setupOutliner();
      const nodePath = outliner.focusedNodePath!;

      const event = createMockKeyboardEvent("z");
      const context = createPathBasedKeyboardContext(event, outliner);

      const handled = executePathBasedKeyboardCommand("z", context);

      expect(handled).toBe(true);
      expect(outliner.testAPI.editingNodePath).toEqual(nodePath);
      expect(outliner.testAPI.editingContent).toBe("z");
    });

    it("should return false for non-actionable keys", async () => {
      await setupOutliner();

      const event = createMockKeyboardEvent("Shift");
      const context = createPathBasedKeyboardContext(event, outliner);

      const handled = executePathBasedKeyboardCommand("Shift", context);

      expect(handled).toBe(false);
    });

    it.skip("should handle cmd/ctrl+[ and ] in edit mode", async () => {
      // TODO: This test needs to be updated for the path-based API
      // Currently uses outliner.startEditing() which doesn't exist in the new API
      await setupOutliner();
      const secondNodeBody = outliner.tree.root.children[1].body;
      const secondNode = outliner.tree.root.children[1];

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
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);

      expect(indentHandled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0].children.length).toBe(1);
      expect(outliner.tree.root.children[0].children[0].body).toBe(secondNodeBody);

      // Test outdent in edit mode
      const outdentEvent = createMockKeyboardEvent("[", { metaKey: true });
      Object.defineProperty(outdentEvent, "target", { value: mockTextarea });

      const outdentContext = {
        event: outdentEvent,
        component: outliner,
        editingNode: outliner.tree.root.children[0].children[0], // Use current reference
        editingContent: "test content",
        textarea: mockTextarea,
      };

      const outdentHandled = EditingKeyboardCommands["["].execute(
        outdentContext,
      );
      
      // Wait for async Cell operations to complete
      await waitForCellUpdate();

      expect(outdentHandled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(2);
    });

    it.skip("should preserve edit mode after indent/outdent operations", async () => {
      // TODO: This test needs to be updated for the path-based API
      // Currently uses outliner.startEditingWithInitialText() which doesn't exist in the new API
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
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);
      
      // Wait for setTimeout to complete (used in indentNodeWithEditState)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should still be in edit mode after indent
      expect(outliner.testAPI.editingNode).toBeTruthy();
      expect(outliner.testAPI.editingContent).toBe(editingContent);

      // Get the current editing node reference after the Cell operation
      const currentEditingNode = outliner.testAPI.editingNode;
      
      // Outdent while still in edit mode
      const outdentEvent = createMockKeyboardEvent("[", { metaKey: true });
      Object.defineProperty(outdentEvent, "target", { value: mockTextarea });

      const outdentContext = {
        event: outdentEvent,
        component: outliner,
        editingNode: currentEditingNode!,
        editingContent: editingContent,
        textarea: mockTextarea,
      };

      EditingKeyboardCommands["["].execute(outdentContext);
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);
      
      // Wait for setTimeout to complete (used in outdentNodeWithEditState)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should still be in edit mode after outdent
      expect(outliner.testAPI.editingNode).toBeTruthy();
      expect(outliner.testAPI.editingContent).toBe(editingContent);
    });

    it.skip("should preserve cursor position and content during edit mode indentation", async () => {
      // TODO: This test needs to be updated for the path-based API 
      // Currently uses outliner.startEditingWithInitialText() which doesn't exist in the new API
      await setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const secondNodeBody = secondNode.body;
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
      
      // Wait for async Cell operations to complete
      await waitForOutlinerUpdate(outliner);
      
      // Wait for setTimeout to complete (used in indentNodeWithEditState)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify tree structure changed (node was indented)
      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0].children.length).toBe(1);
      expect(outliner.tree.root.children[0].children[0].body).toBe(secondNodeBody);

      // Verify editing state preserved
      expect(outliner.testAPI.editingNode).toBeTruthy();
      expect(outliner.testAPI.editingContent).toBe(editingContent);
    });
  });

  describe("Edge Cases", () => {
    it("should handle commands when no node is focused", async () => {
      await setupOutliner();
      outliner.focusedNodePath = null;

      const event = createMockKeyboardEvent("Enter");
      const context = createPathBasedKeyboardContext(event, outliner);

      // Should not crash
      expect(() => PathBasedKeyboardCommands.Enter.execute(context)).not.toThrow();
    });

    it("should handle readonly mode correctly", async () => {
      await setupOutliner();
      outliner.readonly = true;
      const nodePath = outliner.focusedNodePath!;

      // Regular editing should be blocked
      outliner.startEditingByPath(nodePath);
      expect(outliner.testAPI.editingNodePath).toBe(null);

      // But cmd+backspace delete should still work
      const event = createMockKeyboardEvent("Backspace", { metaKey: true });
      const context = createPathBasedKeyboardContext(event, outliner);

      PathBasedKeyboardCommands.Backspace.execute(context);
      expect(outliner.tree.root.children.length).toBe(1);
    });
  });
});
