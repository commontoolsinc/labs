import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { executeKeyboardCommand, handleTypingToEdit, KeyboardCommands, EditingKeyboardCommands } from "./keyboard-commands.ts";
import { CTOutliner } from "./ct-outliner.ts";
import { TreeOperations } from "./tree-operations.ts";
import type { KeyboardContext } from "./types.ts";

// Mock DOM environment for testing
const mockElement = (tagName: string) => ({
  tagName,
  focus: () => {},
  select: () => {},
  setSelectionRange: () => {},
  getBoundingClientRect: () => ({ bottom: 0, left: 0 }),
  style: {},
  value: "",
  selectionStart: 0,
  selectionEnd: 0,
  scrollHeight: 20,
});

const mockShadowRoot = {
  querySelector: (selector: string) => {
    if (selector.includes("editor-")) return mockElement("textarea");
    if (selector === ".outliner") return mockElement("div");
    return null;
  }
};

describe("Keyboard Commands", () => {
  let outliner: CTOutliner;
  let mockEvent: KeyboardEvent;

  function setupOutliner() {
    outliner = new CTOutliner();
    // Mock the shadowRoot
    Object.defineProperty(outliner, 'shadowRoot', {
      value: mockShadowRoot,
      writable: false
    });
    
    // Setup a basic tree
    const tree = {
      root: {
        body: "",
        children: [
          { body: "First item", children: [], attachments: [] },
          { body: "Second item", children: [], attachments: [] }
        ],
        attachments: []
      }
    };
    outliner.tree = tree;
    outliner.focusedNode = tree.root.children[0];
  }

  function createMockKeyboardEvent(key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}): KeyboardEvent {
    return {
      key,
      ctrlKey: modifiers.ctrlKey || false,
      metaKey: modifiers.metaKey || false,
      shiftKey: modifiers.shiftKey || false,
      altKey: modifiers.altKey || false,
      preventDefault: () => {},
      stopPropagation: () => {}
    } as KeyboardEvent;
  }

  function createKeyboardContext(event: KeyboardEvent): KeyboardContext {
    const allNodes = TreeOperations.getAllVisibleNodes(outliner.tree.root, new Set());
    const currentIndex = outliner.focusedNode ? allNodes.indexOf(outliner.focusedNode) : -1;
    
    return {
      event,
      component: outliner,
      allNodes,
      currentIndex,
      focusedNode: outliner.focusedNode,
    };
  }

  describe("Basic Commands", () => {
    it("should handle Enter key to create new node", () => {
      setupOutliner();
      const initialChildCount = outliner.tree.root.children.length;
      
      const event = createMockKeyboardEvent("Enter");
      const context = createKeyboardContext(event);
      
      KeyboardCommands.Enter.execute(context);
      
      expect(outliner.tree.root.children.length).toBe(initialChildCount + 1);
    });

    it("should handle Shift+Enter to create child node", () => {
      setupOutliner();
      const parentNode = outliner.focusedNode!;
      const initialChildCount = parentNode.children.length;
      
      const event = createMockKeyboardEvent("Enter", { shiftKey: true });
      const context = createKeyboardContext(event);
      
      KeyboardCommands.Enter.execute(context);
      
      expect(parentNode.children.length).toBe(initialChildCount + 1);
    });

    it("should handle cmd/ctrl+Enter to toggle edit mode", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      const event = createMockKeyboardEvent("Enter", { metaKey: true });
      const context = createKeyboardContext(event);
      
      // Should start editing
      KeyboardCommands.Enter.execute(context);
      expect(outliner._testHelpers.editingNode).toBe(node);
      
      // Should stop editing
      KeyboardCommands.Enter.execute(context);
      expect(outliner._testHelpers.editingNode).toBe(null);
    });

    it("should exit edit mode with cmd/ctrl+Enter when already editing", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      const initialNodeCount = outliner.tree.root.children.length;
      
      // Start editing first
      outliner.startEditing(node);
      expect(outliner._testHelpers.editingNode).toBe(node);
      
      // Simulate the editing keyboard handler behavior for cmd/ctrl+Enter
      // This tests the actual flow when in edit mode
      const mockTextarea = {
        selectionStart: 0,
        selectionEnd: 0,
        value: "test content"
      } as HTMLTextAreaElement;
      
      const event = createMockKeyboardEvent("Enter", { metaKey: true });
      Object.defineProperty(event, 'target', { value: mockTextarea });
      
      // Call the editing keyboard handler directly
      outliner._testHelpers.handleNormalEditorKeyDown(event);
      
      // Should exit edit mode
      expect(outliner._testHelpers.editingNode).toBe(null);
      // Should NOT create a new node
      expect(outliner.tree.root.children.length).toBe(initialNodeCount);
    });

    it("should handle Space key to start editing", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      const event = createMockKeyboardEvent(" ");
      const context = createKeyboardContext(event);
      
      KeyboardCommands[" "].execute(context);
      
      expect(outliner._testHelpers.editingNode).toBe(node);
      expect(outliner._testHelpers.editingContent).toBe(node.body);
    });

    it("should handle Delete key to delete node", () => {
      setupOutliner();
      const nodeToDelete = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];
      
      const event = createMockKeyboardEvent("Delete");
      const context = createKeyboardContext(event);
      
      KeyboardCommands.Delete.execute(context);
      
      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0]).toBe(secondNode);
    });

    it("should handle cmd/ctrl+Backspace to delete node", () => {
      setupOutliner();
      const nodeToDelete = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];
      
      const event = createMockKeyboardEvent("Backspace", { metaKey: true });
      const context = createKeyboardContext(event);
      
      KeyboardCommands.Backspace.execute(context);
      
      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0]).toBe(secondNode);
    });

    it("should not delete on regular Backspace without modifiers", () => {
      setupOutliner();
      const initialChildCount = outliner.tree.root.children.length;
      
      const event = createMockKeyboardEvent("Backspace");
      const context = createKeyboardContext(event);
      
      KeyboardCommands.Backspace.execute(context);
      
      // Should not delete
      expect(outliner.tree.root.children.length).toBe(initialChildCount);
    });
  });

  describe("Navigation Commands", () => {
    it("should handle Tab key for indentation", () => {
      setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];
      outliner.focusedNode = secondNode;
      
      const event = createMockKeyboardEvent("Tab");
      const context = createKeyboardContext(event);
      
      KeyboardCommands.Tab.execute(context);
      
      expect(outliner.tree.root.children.length).toBe(1);
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);
    });

    it("should handle Shift+Tab for outdentation", () => {
      setupOutliner();
      // Setup nested structure first
      const tree = {
        root: {
          body: "",
          children: [{
            body: "Parent",
            children: [{
              body: "Child",
              children: [],
              attachments: []
            }],
            attachments: []
          }],
          attachments: []
        }
      };
      outliner.tree = tree;
      const childNode = tree.root.children[0].children[0];
      outliner.focusedNode = childNode;
      
      const event = createMockKeyboardEvent("Tab", { shiftKey: true });
      const context = createKeyboardContext(event);
      
      KeyboardCommands.Tab.execute(context);
      
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[1]).toBe(childNode);
    });

    it("should handle arrow key navigation", () => {
      setupOutliner();
      const firstNode = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];
      outliner.focusedNode = firstNode;
      
      const event = createMockKeyboardEvent("ArrowDown");
      const context = createKeyboardContext(event);
      
      KeyboardCommands.ArrowDown.execute(context);
      
      expect(outliner.focusedNode).toBe(secondNode);
    });

    it("should handle cmd/ctrl+] for indentation", () => {
      setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];
      outliner.focusedNode = secondNode;
      
      const event = createMockKeyboardEvent("]", { metaKey: true });
      const context = createKeyboardContext(event);
      
      KeyboardCommands["]"].execute(context);
      
      expect(outliner.tree.root.children.length).toBe(1);
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);
    });

    it("should handle cmd/ctrl+[ for outdentation", () => {
      setupOutliner();
      // Setup nested structure first
      const tree = {
        root: {
          body: "",
          children: [{
            body: "Parent",
            children: [{
              body: "Child",
              children: [],
              attachments: []
            }],
            attachments: []
          }],
          attachments: []
        }
      };
      outliner.tree = tree;
      const childNode = tree.root.children[0].children[0];
      outliner.focusedNode = childNode;
      
      const event = createMockKeyboardEvent("[", { metaKey: true });
      const context = createKeyboardContext(event);
      
      KeyboardCommands["["].execute(context);
      
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[1]).toBe(childNode);
    });

    it("should not indent/outdent without modifiers", () => {
      setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const initialStructure = JSON.stringify(outliner.tree);
      
      // Test ] without modifiers
      const event1 = createMockKeyboardEvent("]");
      const context1 = createKeyboardContext(event1);
      KeyboardCommands["]"].execute(context1);
      
      // Test [ without modifiers  
      const event2 = createMockKeyboardEvent("[");
      const context2 = createKeyboardContext(event2);
      KeyboardCommands["["].execute(context2);
      
      // Structure should be unchanged
      expect(JSON.stringify(outliner.tree)).toBe(initialStructure);
    });
  });

  describe("Typing to Edit", () => {
    it("should enter edit mode when typing regular characters", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      const event = createMockKeyboardEvent("a");
      const context = createKeyboardContext(event);
      
      const handled = handleTypingToEdit("a", context);
      
      expect(handled).toBe(true);
      expect(outliner._testHelpers.editingNode).toBe(node);
      expect(outliner._testHelpers.editingContent).toBe("a");
    });

    it("should not enter edit mode for modifier keys", () => {
      setupOutliner();
      
      const event = createMockKeyboardEvent("a", { ctrlKey: true });
      const context = createKeyboardContext(event);
      
      const handled = handleTypingToEdit("a", context);
      
      expect(handled).toBe(false);
      expect(outliner._testHelpers.editingNode).toBe(null);
    });

    it("should not enter edit mode for special keys", () => {
      setupOutliner();
      
      const event = createMockKeyboardEvent("Enter");
      const context = createKeyboardContext(event);
      
      const handled = handleTypingToEdit("Enter", context);
      
      expect(handled).toBe(false);
      expect(outliner._testHelpers.editingNode).toBe(null);
    });

    it("should overwrite existing content when typing", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      const originalContent = node.body;
      
      const event = createMockKeyboardEvent("x");
      const context = createKeyboardContext(event);
      
      handleTypingToEdit("x", context);
      
      expect(outliner._testHelpers.editingContent).toBe("x");
      expect(outliner._testHelpers.editingContent).not.toBe(originalContent);
    });
  });

  describe("Command Integration", () => {
    it("should execute keyboard commands via executeKeyboardCommand", () => {
      setupOutliner();
      const initialChildCount = outliner.tree.root.children.length;
      
      const event = createMockKeyboardEvent("Enter");
      const context = createKeyboardContext(event);
      
      const handled = executeKeyboardCommand("Enter", context);
      
      expect(handled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(initialChildCount + 1);
    });

    it("should fall back to typing handler for unknown keys", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      const event = createMockKeyboardEvent("z");
      const context = createKeyboardContext(event);
      
      const handled = executeKeyboardCommand("z", context);
      
      expect(handled).toBe(true);
      expect(outliner._testHelpers.editingNode).toBe(node);
      expect(outliner._testHelpers.editingContent).toBe("z");
    });

    it("should return false for non-actionable keys", () => {
      setupOutliner();
      
      const event = createMockKeyboardEvent("Shift");
      const context = createKeyboardContext(event);
      
      const handled = executeKeyboardCommand("Shift", context);
      
      expect(handled).toBe(false);
    });

    it("should handle cmd/ctrl+[ and ] in edit mode", () => {
      setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];
      
      // Start editing
      outliner.startEditing(secondNode);
      expect(outliner._testHelpers.editingNode).toBe(secondNode);
      
      // Test indent in edit mode
      const mockTextarea = {
        selectionStart: 0,
        selectionEnd: 0,
        value: "test content"
      } as HTMLTextAreaElement;
      
      const indentEvent = createMockKeyboardEvent("]", { metaKey: true });
      Object.defineProperty(indentEvent, 'target', { value: mockTextarea });
      
      const indentContext = {
        event: indentEvent,
        component: outliner,
        editingNode: secondNode,
        editingContent: "test content",
        textarea: mockTextarea
      };
      
      const indentHandled = EditingKeyboardCommands["]"].execute(indentContext);
      
      expect(indentHandled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(1);
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);
      
      // Test outdent in edit mode
      const outdentEvent = createMockKeyboardEvent("[", { metaKey: true });
      Object.defineProperty(outdentEvent, 'target', { value: mockTextarea });
      
      const outdentContext = {
        event: outdentEvent,
        component: outliner,
        editingNode: secondNode,
        editingContent: "test content",
        textarea: mockTextarea
      };
      
      const outdentHandled = EditingKeyboardCommands["["].execute(outdentContext);
      
      expect(outdentHandled).toBe(true);
      expect(outliner.tree.root.children.length).toBe(2);
    });
  });

  describe("Edge Cases", () => {
    it("should handle commands when no node is focused", () => {
      setupOutliner();
      outliner.focusedNode = null;
      
      const event = createMockKeyboardEvent("Enter");
      const context = createKeyboardContext(event);
      
      // Should not crash
      expect(() => KeyboardCommands.Enter.execute(context)).not.toThrow();
    });

    it("should handle readonly mode correctly", () => {
      setupOutliner();
      outliner.readonly = true;
      const node = outliner.focusedNode!;
      
      // Regular editing should be blocked
      outliner.startEditing(node);
      expect(outliner._testHelpers.editingNode).toBe(null);
      
      // But cmd+backspace delete should still work
      const event = createMockKeyboardEvent("Backspace", { metaKey: true });
      const context = createKeyboardContext(event);
      
      KeyboardCommands.Backspace.execute(context);
      expect(outliner.tree.root.children.length).toBe(1);
    });
  });
});