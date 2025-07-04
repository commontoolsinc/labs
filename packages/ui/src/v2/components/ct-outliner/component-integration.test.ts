import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTOutliner } from "./ct-outliner.ts";
import { TreeOperations } from "./tree-operations.ts";

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

describe("CTOutliner Component Integration Tests", () => {
  let outliner: CTOutliner;

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

  describe("Node Creation", () => {
    it("should create new sibling node with Enter", () => {
      setupOutliner();
      const initialCount = outliner.tree.root.children.length;
      
      outliner.createNewNodeAfter(outliner.focusedNode!);
      
      expect(outliner.tree.root.children.length).toBe(initialCount + 1);
      expect(outliner.focusedNode!.body).toBe("");
    });

    it("should create child node with Shift+Enter equivalent", () => {
      setupOutliner();
      const parentNode = outliner.focusedNode!;
      const initialChildCount = parentNode.children.length;
      
      outliner.createChildNode(parentNode);
      
      // Since tree is mutable, parentNode should have the new child
      expect(parentNode.children.length).toBe(initialChildCount + 1);
      expect(outliner.focusedNode!.body).toBe("");
    });
  });

  describe("Node Deletion", () => {
    it("should delete node and update focus", () => {
      setupOutliner();
      const nodeToDelete = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];
      
      outliner.deleteNode(nodeToDelete);
      
      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0]).toBe(secondNode);
    });
  });

  describe("Node Indentation", () => {
    it("should indent node correctly", () => {
      setupOutliner();
      const secondNode = outliner.tree.root.children[1];
      const firstNode = outliner.tree.root.children[0];
      
      outliner.indentNode(secondNode);
      
      expect(outliner.tree.root.children.length).toBe(1);
      // Since tree is mutable, firstNode should have the new child
      expect(firstNode.children.length).toBe(1);
      expect(firstNode.children[0]).toBe(secondNode);
    });

    it("should outdent node correctly", () => {
      setupOutliner();
      // Setup nested structure
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
      
      outliner.outdentNode(childNode);
      
      expect(outliner.tree.root.children.length).toBe(2);
      expect(outliner.tree.root.children[1]).toBe(childNode);
    });
  });

  describe("Editing Mode", () => {
    it("should enter edit mode and preserve content", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      outliner.startEditing(node);
      
      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe(node.body);
    });

    it("should start editing with initial text", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      const initialText = "Hello";
      
      outliner.startEditingWithInitialText(node, initialText);
      
      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe(initialText);
    });
  });

  describe("Tree Structure Integrity", () => {
    it("should preserve node references after operations", () => {
      setupOutliner();
      const originalFirstNode = outliner.tree.root.children[0];
      const originalSecondNode = outliner.tree.root.children[1];
      
      // Create a new node
      outliner.createNewNodeAfter(originalFirstNode);
      
      // Original nodes should still be present and identifiable
      expect(outliner.tree.root.children[0]).toBe(originalFirstNode);
      expect(outliner.tree.root.children[2]).toBe(originalSecondNode);
    });

    it("should maintain focus correctly after tree modifications", () => {
      setupOutliner();
      const firstNode = outliner.tree.root.children[0];
      
      // Create new node and verify focus is on new node
      outliner.createNewNodeAfter(firstNode);
      expect(outliner.focusedNode!.body).toBe("");
      expect(outliner.focusedNode).not.toBe(firstNode);
    });
  });

  describe("Public API Methods", () => {
    it("should have all required public methods accessible", () => {
      setupOutliner();
      
      expect(typeof outliner.createNewNodeAfter).toBe("function");
      expect(typeof outliner.createChildNode).toBe("function");
      expect(typeof outliner.deleteNode).toBe("function");
      expect(typeof outliner.indentNode).toBe("function");
      expect(typeof outliner.outdentNode).toBe("function");
      expect(typeof outliner.startEditing).toBe("function");
      expect(typeof outliner.startEditingWithInitialText).toBe("function");
      expect(typeof outliner.toggleEditMode).toBe("function");
      expect(typeof outliner.emitChange).toBe("function");
    });
  });

  describe("Keyboard Commands", () => {
    it("should toggle edit mode with cmd/ctrl+enter", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      // Should start editing
      outliner.toggleEditMode(node);
      expect(outliner.testAPI.editingNode).toBe(node);
      
      // Should stop editing
      outliner.toggleEditMode(node);
      expect(outliner.testAPI.editingNode).toBe(null);
    });

    it("should replace content when typing to enter edit mode", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      outliner.startEditingWithInitialText(node, "x");
      
      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe("x");
    });

    it("should delete node with cmd/ctrl+backspace in read mode", () => {
      setupOutliner();
      const nodeToDelete = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];
      outliner.focusedNode = nodeToDelete;
      
      // Test deletion works
      outliner.deleteNode(nodeToDelete);
      
      expect(outliner.tree.root.children.length).toBe(1);
      expect(outliner.tree.root.children[0]).toBe(secondNode);
    });

    it("should preserve existing content when starting normal edit mode", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      const originalContent = node.body;
      
      outliner.startEditing(node);
      
      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe(originalContent);
    });

    it("should overwrite content when typing to enter edit mode", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      // Start editing with initial text - should replace entire content
      outliner.startEditingWithInitialText(node, "new content");
      
      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe("new content");
    });

    it("should toggle between editing states correctly", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      
      // Start with no editing
      expect(outliner.testAPI.editingNode).toBe(null);
      
      // Toggle to start editing
      outliner.toggleEditMode(node);
      expect(outliner.testAPI.editingNode).toBe(node);
      expect(outliner.testAPI.editingContent).toBe(node.body);
      
      // Toggle to stop editing  
      outliner.toggleEditMode(node);
      expect(outliner.testAPI.editingNode).toBe(null);
      expect(outliner.testAPI.editingContent).toBe("");
    });

    it("should handle switching edit mode between different nodes", () => {
      setupOutliner();
      const firstNode = outliner.tree.root.children[0];
      const secondNode = outliner.tree.root.children[1];
      
      // Start editing first node
      outliner.toggleEditMode(firstNode);
      expect(outliner.testAPI.editingNode).toBe(firstNode);
      
      // Switch to editing second node (should stop editing first)
      outliner.toggleEditMode(secondNode);
      expect(outliner.testAPI.editingNode).toBe(secondNode);
      expect(outliner.testAPI.editingContent).toBe(secondNode.body);
    });

    it("should exit edit mode with cmd/ctrl+enter without creating new node", () => {
      setupOutliner();
      const node = outliner.focusedNode!;
      const initialNodeCount = outliner.tree.root.children.length;
      
      // Start editing
      outliner.startEditing(node);
      expect(outliner.testAPI.editingNode).toBe(node);
      
      // Simulate cmd/ctrl+Enter in edit mode through the editor keyboard handler
      const mockTextarea = {
        selectionStart: 0,
        selectionEnd: 0,
        value: "test content"
      } as HTMLTextAreaElement;
      
      const event = {
        key: "Enter",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: mockTextarea,
        preventDefault: () => {},
        stopPropagation: () => {}
      } as unknown as KeyboardEvent;
      
      // Call the editor key handler
      outliner.testAPI.handleNormalEditorKeyDown(event);
      
      // Should exit edit mode
      expect(outliner.testAPI.editingNode).toBe(null);
      // Should NOT create a new node
      expect(outliner.tree.root.children.length).toBe(initialNodeCount);
    });
  });
});