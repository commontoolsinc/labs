import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTOutliner } from "./ct-outliner.ts";

// Helper to create and setup outliner instance
function createOutliner(initialValue = "") {
  const outliner = new CTOutliner();
  outliner.value = initialValue;
  outliner.readonly = false;
  outliner.mentionable = [];
  
  // Simulate connectedCallback
  outliner.connectedCallback();
  
  return outliner;
}

// Helper to simulate key events
function createKeyEvent(key: string, options: {
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
} = {}) {
  return new KeyboardEvent("keydown", {
    key,
    shiftKey: options.shiftKey || false,
    altKey: options.altKey || false,
    metaKey: options.metaKey || false,
    ctrlKey: options.ctrlKey || false,
    bubbles: true,
    cancelable: true,
  });
}

describe("CTOutliner", () => {
  describe("Initialization", () => {
    it("creates empty node when no value provided", () => {
      const outliner = createOutliner();
      expect(outliner.nodes).toHaveLength(1);
      expect(outliner.nodes[0].content).toBe("");
      expect(outliner.nodes[0].level).toBe(0);
      expect(outliner.focusedNodeId).toBe(outliner.nodes[0].id);
    });

    it("parses markdown value into node structure", () => {
      const markdown = "- Item 1\n  - Subitem 1\n  - Subitem 2\n- Item 2";
      const outliner = createOutliner(markdown);
      
      expect(outliner.nodes).toHaveLength(2);
      expect(outliner.nodes[0].content).toBe("Item 1");
      expect(outliner.nodes[0].level).toBe(0);
      expect(outliner.nodes[0].children).toHaveLength(2);
      expect(outliner.nodes[0].children[0].content).toBe("Subitem 1");
      expect(outliner.nodes[0].children[0].level).toBe(1);
      expect(outliner.nodes[1].content).toBe("Item 2");
      expect(outliner.nodes[1].level).toBe(0);
    });
  });

  describe("Navigation", () => {
    it("moves focus with arrow keys", () => {
      const markdown = "- Item 1\n- Item 2\n- Item 3";
      const outliner = createOutliner(markdown);
      
      const initialFocusId = outliner.focusedNodeId;
      
      // Move down
      const downEvent = createKeyEvent("ArrowDown");
      outliner._testHelpers.handleKeyDown(downEvent);
      expect(outliner.focusedNodeId).not.toBe(initialFocusId);
      
      // Move up
      const upEvent = createKeyEvent("ArrowUp");
      outliner._testHelpers.handleKeyDown(upEvent);
      expect(outliner.focusedNodeId).toBe(initialFocusId);
    });

    it("navigates to first/last node with Home/End", () => {
      const markdown = "- Item 1\n- Item 2\n- Item 3";
      const outliner = createOutliner(markdown);
      
      const firstNodeId = outliner.nodes[0].id;
      const lastNodeId = outliner.nodes[outliner.nodes.length - 1].id;
      
      // Go to end
      const endEvent = createKeyEvent("End");
      outliner._testHelpers.handleKeyDown(endEvent);
      expect(outliner.focusedNodeId).toBe(lastNodeId);
      
      // Go to home
      const homeEvent = createKeyEvent("Home");
      outliner._testHelpers.handleKeyDown(homeEvent);
      expect(outliner.focusedNodeId).toBe(firstNodeId);
    });
  });

  describe("Node Creation", () => {
    it("creates sibling node with Shift+Enter", () => {
      const outliner = createOutliner("- Item 1");
      const initialNodeCount = outliner.nodes.length;
      
      // Focus first node and create sibling
      outliner.focusedNodeId = outliner.nodes[0].id;
      const shiftEnterEvent = createKeyEvent("Enter", { shiftKey: true });
      outliner._testHelpers.handleKeyDown(shiftEnterEvent);
      
      expect(outliner.nodes).toHaveLength(initialNodeCount + 1);
      expect(outliner.nodes[1].content).toBe("");
      expect(outliner.nodes[1].level).toBe(0);
    });

    it("creates child node with Alt+Enter", () => {
      const outliner = createOutliner("- Parent");
      const parentNode = outliner.nodes[0];
      
      // Focus parent and create child
      outliner.focusedNodeId = parentNode.id;
      const altEnterEvent = createKeyEvent("Enter", { altKey: true });
      outliner._testHelpers.handleKeyDown(altEnterEvent);
      
      expect(parentNode.children).toHaveLength(1);
      expect(parentNode.children[0].content).toBe("");
      expect(parentNode.children[0].level).toBe(1);
      expect(parentNode.collapsed).toBe(false);
    });
  });

  describe("Node Manipulation", () => {
    it("moves node up with Alt+Arrow keys", () => {
      const markdown = "- Item 1\n- Item 2\n- Item 3";
      const outliner = createOutliner(markdown);
      
      const secondNodeId = outliner.nodes[1].id;
      const secondNodeContent = outliner.nodes[1].content;
      
      // Focus second node and move up
      outliner.focusedNodeId = secondNodeId;
      const altUpEvent = createKeyEvent("ArrowUp", { altKey: true });
      outliner._testHelpers.handleKeyDown(altUpEvent);
      
      // Second node should now be first
      expect(outliner.nodes[0].id).toBe(secondNodeId);
      expect(outliner.nodes[0].content).toBe(secondNodeContent);
    });

    it("indents node with Tab", () => {
      const markdown = "- Item 1\n- Item 2";
      const outliner = createOutliner(markdown);
      
      const secondNode = outliner.nodes[1];
      const firstNode = outliner.nodes[0];
      
      // Focus second node and indent
      outliner.focusedNodeId = secondNode.id;
      const tabEvent = createKeyEvent("Tab");
      outliner._testHelpers.handleKeyDown(tabEvent);
      
      // Second node should now be child of first
      expect(firstNode.children).toHaveLength(1);
      expect(firstNode.children[0].id).toBe(secondNode.id);
      expect(secondNode.level).toBe(1);
    });
  });

  describe("Collapse/Expand", () => {
    it("toggles collapse with Space", () => {
      const markdown = "- Parent\n  - Child";
      const outliner = createOutliner(markdown);
      
      const parentNode = outliner.nodes[0];
      
      // Focus parent and toggle collapse
      outliner.focusedNodeId = parentNode.id;
      const spaceEvent = createKeyEvent(" ");
      outliner._testHelpers.handleKeyDown(spaceEvent);
      
      expect(parentNode.collapsed).toBe(true);
      
      // Toggle again
      outliner._testHelpers.handleKeyDown(spaceEvent);
      expect(parentNode.collapsed).toBe(false);
    });
  });

  describe("Editing Mode", () => {
    it("enters edit mode with Enter", () => {
      const outliner = createOutliner("- Test item");
      
      // Focus node and enter edit mode
      outliner.focusedNodeId = outliner.nodes[0].id;
      const enterEvent = createKeyEvent("Enter");
      outliner._testHelpers.handleKeyDown(enterEvent);
      
      expect(outliner._testHelpers.editingNodeId).toBe(outliner.nodes[0].id);
      expect(outliner._testHelpers.editingContent).toBe("Test item");
    });

    it("exits edit mode and saves with Enter", () => {
      const outliner = createOutliner("- Test item");
      const node = outliner.nodes[0];
      
      // Enter edit mode and modify content
      outliner._testHelpers.startEditing(node.id);
      // Simulate content change
      (outliner as any).editingContent = "Updated content";
      
      // Exit with Enter
      const enterEvent = createKeyEvent("Enter");
      outliner._testHelpers.handleEditorKeyDown(enterEvent);
      
      expect(outliner._testHelpers.editingNodeId).toBe(null);
      expect(node.content).toBe("Updated content");
    });

    it("creates new node with Cmd+Enter in edit mode", () => {
      const outliner = createOutliner("- Test item");
      const initialCount = outliner.nodes.length;
      
      // Enter edit mode
      outliner._testHelpers.startEditing(outliner.nodes[0].id);
      
      // Create new node with Cmd+Enter
      const cmdEnterEvent = createKeyEvent("Enter", { metaKey: true });
      outliner._testHelpers.handleEditorKeyDown(cmdEnterEvent);
      
      expect(outliner.nodes).toHaveLength(initialCount + 1);
    });
  });

  describe("Markdown Conversion", () => {
    it("converts nodes to markdown correctly", () => {
      const outliner = createOutliner();
      
      // Create a structure: Parent -> Child -> Grandchild
      const parent = outliner._testHelpers.createNode("Parent", 0);
      const child = outliner._testHelpers.createNode("Child", 1);
      const grandchild = outliner._testHelpers.createNode("Grandchild", 2);
      
      child.children = [grandchild];
      parent.children = [child];
      outliner.nodes = [parent];
      
      const markdown = outliner._testHelpers.nodesToMarkdown(outliner.nodes);
      const expected = "- Parent\n  - Child\n    - Grandchild";
      
      expect(markdown).toBe(expected);
    });

    it("emits change events when content updates", () => {
      const outliner = createOutliner("- Test");
      let changeEventFired = false;
      let changeData: any = null;
      
      outliner.addEventListener("ct-change", (event: any) => {
        changeEventFired = true;
        changeData = event.detail;
      });
      
      // Modify content and emit change
      outliner.nodes[0].content = "Updated test";
      outliner._testHelpers.emitChange();
      
      expect(changeEventFired).toBe(true);
      expect(changeData.value).toContain("Updated test");
    });
  });

  describe("Value Property", () => {
    it("updates nodes when value property changes", () => {
      const outliner = createOutliner("- Initial");
      expect(outliner.nodes[0].content).toBe("Initial");
      
      // Change value property
      outliner.value = "- Updated\n  - With child";
      
      // Trigger updated lifecycle
      outliner.updated(new Map([["value", "- Initial"]]));
      
      expect(outliner.nodes).toHaveLength(1);
      expect(outliner.nodes[0].content).toBe("Updated");
      expect(outliner.nodes[0].children).toHaveLength(1);
      expect(outliner.nodes[0].children[0].content).toBe("With child");
    });

    it("maintains focus when possible after value update", () => {
      const outliner = createOutliner("- Item 1\n- Item 2");
      const firstNodeId = outliner.nodes[0].id;
      outliner.focusedNodeId = firstNodeId;
      
      // Update with similar structure
      outliner.value = "- Item 1\n- Item 2\n- Item 3";
      outliner.updated(new Map([["value", "- Item 1\n- Item 2"]]));
      
      // Focus should transfer to a node (may not be same ID due to recreation)
      expect(outliner.focusedNodeId).toBeTruthy();
    });
  });
});