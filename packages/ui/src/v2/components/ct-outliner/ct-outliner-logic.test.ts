import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TreeOperations, EditingOperations, KeyboardCommands } from "./ct-outliner.ts";

// Test the core logic without DOM dependencies
describe("CTOutliner Logic Tests", () => {
  // Test markdown parsing logic
  describe("Markdown Parsing", () => {
    function parseMarkdown(markdown: string) {
      if (!markdown.trim()) return [];

      const lines = markdown.split("\n");
      const root: any[] = [];
      const stack: { node: any; parent: any[] }[] = [];
      let nodeIdCounter = 0;

      for (const line of lines) {
        const match = line.match(/^(\s*)-\s(.*)$/);
        if (!match) continue;

        const [, indent, content] = match;
        const level = Math.floor(indent.length / 2);
        const node = {
          id: `node-${nodeIdCounter++}`,
          content,
          children: [],
          collapsed: false,
          level,
        };

        while (stack.length > 0 && stack[stack.length - 1].node.level >= level) {
          stack.pop();
        }

        if (stack.length === 0) {
          root.push(node);
        } else {
          stack[stack.length - 1].node.children.push(node);
        }

        stack.push({
          node,
          parent: stack.length === 0
            ? root
            : stack[stack.length - 1].node.children,
        });
      }

      return root;
    }

    it("parses simple list correctly", () => {
      const markdown = "- Item 1\n- Item 2\n- Item 3";
      const nodes = parseMarkdown(markdown);

      expect(nodes).toHaveLength(3);
      expect(nodes[0].content).toBe("Item 1");
      expect(nodes[0].level).toBe(0);
      expect(nodes[1].content).toBe("Item 2");
      expect(nodes[2].content).toBe("Item 3");
    });

    it("parses nested list correctly", () => {
      const markdown = "- Parent\n  - Child 1\n  - Child 2\n- Parent 2";
      const nodes = parseMarkdown(markdown);

      expect(nodes).toHaveLength(2);
      expect(nodes[0].content).toBe("Parent");
      expect(nodes[0].children).toHaveLength(2);
      expect(nodes[0].children[0].content).toBe("Child 1");
      expect(nodes[0].children[0].level).toBe(1);
      expect(nodes[0].children[1].content).toBe("Child 2");
      expect(nodes[1].content).toBe("Parent 2");
    });

    it("handles deep nesting", () => {
      const markdown = "- Level 0\n  - Level 1\n    - Level 2\n      - Level 3";
      const nodes = parseMarkdown(markdown);

      expect(nodes).toHaveLength(1);
      const level0 = nodes[0];
      expect(level0.content).toBe("Level 0");
      expect(level0.level).toBe(0);

      const level1 = level0.children[0];
      expect(level1.content).toBe("Level 1");
      expect(level1.level).toBe(1);

      const level2 = level1.children[0];
      expect(level2.content).toBe("Level 2");
      expect(level2.level).toBe(2);

      const level3 = level2.children[0];
      expect(level3.content).toBe("Level 3");
      expect(level3.level).toBe(3);
    });
  });

  describe("Markdown Generation", () => {
    function nodesToMarkdown(nodes: any[], baseLevel = 0): string {
      return nodes
        .map((node) => {
          const indent = "  ".repeat(node.level);
          const line = `${indent}- ${node.content}`;
          const childLines = node.children.length > 0
            ? "\n" + nodesToMarkdown(node.children, node.level + 1)
            : "";
          return line + childLines;
        })
        .join("\n");
    }

    it("converts simple nodes to markdown", () => {
      const nodes = [
        { id: "1", content: "Item 1", level: 0, children: [], collapsed: false },
        { id: "2", content: "Item 2", level: 0, children: [], collapsed: false },
      ];

      const markdown = nodesToMarkdown(nodes);
      expect(markdown).toBe("- Item 1\n- Item 2");
    });

    it("converts nested nodes to markdown", () => {
      const nodes = [
        {
          id: "1",
          content: "Parent",
          level: 0,
          children: [
            { id: "2", content: "Child 1", level: 1, children: [], collapsed: false },
            { id: "3", content: "Child 2", level: 1, children: [], collapsed: false },
          ],
          collapsed: false,
        },
      ];

      const markdown = nodesToMarkdown(nodes);
      expect(markdown).toBe("- Parent\n  - Child 1\n  - Child 2");
    });
  });

  describe("Node Navigation Logic", () => {
    function getAllVisibleNodes(nodes: any[]): any[] {
      const result: any[] = [];
      for (const node of nodes) {
        result.push(node);
        if (!node.collapsed && node.children.length > 0) {
          result.push(...getAllVisibleNodes(node.children));
        }
      }
      return result;
    }

    it("gets all visible nodes when not collapsed", () => {
      const nodes = [
        {
          id: "1",
          content: "Parent",
          level: 0,
          collapsed: false,
          children: [
            { id: "2", content: "Child", level: 1, children: [], collapsed: false },
          ],
        },
      ];

      const visible = getAllVisibleNodes(nodes);
      expect(visible).toHaveLength(2);
      expect(visible[0].id).toBe("1");
      expect(visible[1].id).toBe("2");
    });

    it("hides children when collapsed", () => {
      const nodes = [
        {
          id: "1",
          content: "Parent",
          level: 0,
          collapsed: true,
          children: [
            { id: "2", content: "Child", level: 1, children: [], collapsed: false },
          ],
        },
      ];

      const visible = getAllVisibleNodes(nodes);
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe("1");
    });
  });

  describe("Node Manipulation Logic", () => {
    function moveNodeUp(nodes: any[], nodeId: string): any[] {
      const flatNodes = getAllVisibleNodes(nodes);
      const nodeIndex = flatNodes.findIndex(n => n.id === nodeId);
      
      if (nodeIndex <= 0) return nodes; // Can't move up
      
      // Find the parent arrays for both nodes
      const targetNode = flatNodes[nodeIndex];
      const previousNode = flatNodes[nodeIndex - 1];
      
      // Simple swap logic for same-level siblings
      if (targetNode.level === previousNode.level) {
        // This is a simplified version - actual implementation would need
        // to find parent arrays and swap positions
        return nodes;
      }
      
      return nodes;
    }

    function getAllVisibleNodes(nodes: any[]): any[] {
      const result: any[] = [];
      for (const node of nodes) {
        result.push(node);
        if (!node.collapsed && node.children.length > 0) {
          result.push(...getAllVisibleNodes(node.children));
        }
      }
      return result;
    }

    it("correctly identifies node positions", () => {
      const nodes = [
        { id: "1", content: "First", level: 0, children: [], collapsed: false },
        { id: "2", content: "Second", level: 0, children: [], collapsed: false },
        { id: "3", content: "Third", level: 0, children: [], collapsed: false },
      ];

      const flatNodes = getAllVisibleNodes(nodes);
      expect(flatNodes).toHaveLength(3);
      expect(flatNodes[1].id).toBe("2");
    });

    it("handles indentation level calculation", () => {
      const nodes = [
        {
          id: "1",
          content: "Parent",
          level: 0,
          collapsed: false,
          children: [
            { id: "2", content: "Child", level: 1, children: [], collapsed: false },
          ],
        },
      ];

      const flatNodes = getAllVisibleNodes(nodes);
      expect(flatNodes[0].level).toBe(0);
      expect(flatNodes[1].level).toBe(1);
    });
  });

  describe("Key Behavior Logic", () => {
    it("validates key combinations", () => {
      // Test that our key event logic handles modifiers correctly
      const isShiftEnter = (shiftKey: boolean, key: string) => {
        return shiftKey && key === "Enter";
      };
      
      const isAltEnter = (altKey: boolean, key: string) => {
        return altKey && key === "Enter";
      };
      
      const isCmdEnter = (metaKey: boolean, ctrlKey: boolean, key: string) => {
        return (metaKey || ctrlKey) && key === "Enter";
      };

      expect(isShiftEnter(true, "Enter")).toBe(true);
      expect(isShiftEnter(false, "Enter")).toBe(false);
      expect(isAltEnter(true, "Enter")).toBe(true);
      expect(isAltEnter(false, "Enter")).toBe(false);
      expect(isCmdEnter(true, false, "Enter")).toBe(true);
      expect(isCmdEnter(false, true, "Enter")).toBe(true);
      expect(isCmdEnter(false, false, "Enter")).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("handles empty markdown", () => {
      const markdown = "";
      const parseMarkdown = (md: string) => md.trim() ? md.split("\n") : [];
      
      const lines = parseMarkdown(markdown);
      expect(lines).toHaveLength(0);
    });

    it("handles whitespace-only markdown", () => {
      const markdown = "   \n  \n   ";
      const parseMarkdown = (md: string) => md.trim() ? md.split("\n") : [];
      
      const lines = parseMarkdown(markdown);
      expect(lines).toHaveLength(0);
    });

    it("handles invalid markdown lines", () => {
      const markdown = "- Valid item\nInvalid line\n- Another valid item";
      
      function parseMarkdown(markdown: string) {
        if (!markdown.trim()) return [];
        
        const lines = markdown.split("\n");
        const validLines = lines.filter(line => line.match(/^(\s*)-\s(.*)$/));
        
        return validLines.map((line, index) => {
          const match = line.match(/^(\s*)-\s(.*)$/);
          if (match) {
            const [, indent, content] = match;
            return {
              id: `node-${index}`,
              content,
              level: Math.floor(indent.length / 2),
              children: [],
              collapsed: false,
            };
          }
          return null;
        }).filter(Boolean) as any[];
      }
      
      const nodes = parseMarkdown(markdown);
      expect(nodes).toHaveLength(2);
      expect(nodes[0]?.content).toBe("Valid item");
      expect(nodes[1]?.content).toBe("Another valid item");
    });
  });

  describe("TreeOperations Module", () => {
    const sampleNodes = [
      {
        id: "node-1",
        content: "Root 1",
        level: 0,
        collapsed: false,
        children: [
          {
            id: "node-2",
            content: "Child 1",
            level: 1,
            collapsed: false,
            children: [],
          },
        ],
      },
      {
        id: "node-3", 
        content: "Root 2",
        level: 0,
        collapsed: false,
        children: [],
      },
    ];

    it("finds nodes by ID", () => {
      const node = TreeOperations.findNode(sampleNodes, "node-2");
      expect(node?.content).toBe("Child 1");
      expect(node?.level).toBe(1);
    });

    it("returns null for non-existent nodes", () => {
      const node = TreeOperations.findNode(sampleNodes, "non-existent");
      expect(node).toBe(null);
    });

    it("finds parent node correctly", () => {
      const parent = TreeOperations.findParentNode(sampleNodes, "node-2");
      expect(parent?.id).toBe("node-1");
    });

    it("gets all visible nodes respecting collapsed state", () => {
      const visibleNodes = TreeOperations.getAllVisibleNodes(sampleNodes);
      expect(visibleNodes).toHaveLength(3);
      expect(visibleNodes.map(n => n.id)).toEqual(["node-1", "node-2", "node-3"]);
    });

    it("hides children when parent is collapsed", () => {
      const collapsedNodes = [
        {
          ...sampleNodes[0],
          collapsed: true,
        },
        sampleNodes[1],
      ];
      
      const visibleNodes = TreeOperations.getAllVisibleNodes(collapsedNodes);
      expect(visibleNodes).toHaveLength(2);
      expect(visibleNodes.map(n => n.id)).toEqual(["node-1", "node-3"]);
    });

    it("creates nodes with correct structure", () => {
      const node = TreeOperations.createNode("Test Content", 2, 42);
      expect(node.id).toBe("node-42");
      expect(node.content).toBe("Test Content");
      expect(node.level).toBe(2);
      expect(node.collapsed).toBe(false);
      expect(node.children).toHaveLength(0);
    });
  });

  describe("EditingOperations Module", () => {
    const sampleNodes = [
      {
        id: "node-1",
        content: "Original Content",
        level: 0,
        collapsed: false,
        children: [],
      },
    ];

    it("completes edit successfully", () => {
      const result = EditingOperations.completeEdit(
        sampleNodes,
        "node-1",
        "Updated Content"
      );
      
      expect(result.success).toBe(true);
      expect(sampleNodes[0].content).toBe("Updated Content");
    });

    it("fails to edit non-existent node", () => {
      const result = EditingOperations.completeEdit(
        sampleNodes,
        "non-existent",
        "New Content"
      );
      
      expect(result.success).toBe(false);
    });

    it("prepares editing state correctly", () => {
      const state = EditingOperations.prepareEditingState(
        null,
        "",
        "node-1",
        "Node Content"
      );
      
      expect(state.editingNodeId).toBe("node-1");
      expect(state.editingContent).toBe("Node Content");
      expect(state.showingMentions).toBe(false);
    });

    it("clears editing state correctly", () => {
      const state = EditingOperations.clearEditingState();
      
      expect(state.editingNodeId).toBe(null);
      expect(state.editingContent).toBe("");
      expect(state.showingMentions).toBe(false);
    });
  });

  describe("KeyboardCommands Module", () => {
    // Mock context for testing commands
    const createMockContext = (focusedNodeId: string | null = "node-1") => ({
      event: { 
        preventDefault: () => {}, 
        key: "ArrowUp",
        altKey: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
      } as KeyboardEvent,
      component: {
        focusedNodeId,
        findNode: () => ({ id: "node-1", content: "Test", level: 0, children: [], collapsed: false }),
        requestUpdate: () => {},
      } as any,
      allNodes: [
        { id: "node-1", content: "First", level: 0, children: [], collapsed: false },
        { id: "node-2", content: "Second", level: 0, children: [], collapsed: false },
      ],
      currentIndex: 0,
      focusedNodeId,
    });

    it("ArrowDown command moves focus to next node", () => {
      const ctx = createMockContext("node-1");
      KeyboardCommands.ArrowDown.execute(ctx);
      
      expect(ctx.component.focusedNodeId).toBe("node-2");
    });

    it("ArrowUp command moves focus to previous node", () => {
      const ctx = createMockContext("node-2");
      ctx.currentIndex = 1;
      KeyboardCommands.ArrowUp.execute(ctx);
      
      expect(ctx.component.focusedNodeId).toBe("node-1");
    });

    it("Home command moves focus to first node", () => {
      const ctx = createMockContext("node-2");
      KeyboardCommands.Home.execute(ctx);
      
      expect(ctx.component.focusedNodeId).toBe("node-1");
    });

    it("End command moves focus to last node", () => {
      const ctx = createMockContext("node-1");
      KeyboardCommands.End.execute(ctx);
      
      expect(ctx.component.focusedNodeId).toBe("node-2");
    });
  });
});