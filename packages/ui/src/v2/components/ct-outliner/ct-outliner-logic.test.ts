import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TreeOperations } from "./tree-operations.ts";
import { KeyboardCommands } from "./keyboard-commands.ts";
import type { Tree, Node, Block } from "./types.ts";

// Test the core logic without DOM dependencies
describe("CTOutliner Logic Tests", () => {
  // Test Tree structure and TreeOperations
  describe("Tree Operations", () => {
    function createTestTree(): Tree {
      const rootId = TreeOperations.createId();
      const child1Id = TreeOperations.createId();
      const child2Id = TreeOperations.createId();
      
      return {
        root: {
          id: rootId,
          children: [
            { id: child1Id, children: [] },
            { id: child2Id, children: [] }
          ]
        },
        blocks: [
          { id: child1Id, body: "First item", attachments: [] },
          { id: child2Id, body: "Second item", attachments: [] }
        ],
        attachments: []
      };
    }

    it("should create empty tree", () => {
      const tree = TreeOperations.createEmptyTree();
      expect(tree.root.children).toHaveLength(0);
      expect(tree.blocks).toHaveLength(1); // Has one empty root block
      expect(tree.attachments).toHaveLength(0);
      expect(tree.blocks[0].body).toBe("");
    });

    it("should find nodes by ID", () => {
      const tree = createTestTree();
      const child1Id = tree.root.children[0].id;
      const foundNode = TreeOperations.findNode(tree.root, child1Id);
      expect(foundNode).toBeTruthy();
      expect(foundNode!.id).toBe(child1Id);
    });

    it("should find blocks by ID", () => {
      const tree = createTestTree();
      const blockId = tree.blocks[0].id;
      const foundBlock = TreeOperations.findBlock(tree, blockId);
      expect(foundBlock).toBeTruthy();
      expect(foundBlock!.body).toBe("First item");
    });

    it("should update block content", () => {
      const tree = createTestTree();
      const blockId = tree.blocks[0].id;
      const updatedTree = TreeOperations.updateBlock(tree, blockId, "Updated content");
      const updatedBlock = TreeOperations.findBlock(updatedTree, blockId);
      expect(updatedBlock!.body).toBe("Updated content");
    });

    it("should move nodes up", () => {
      const tree = createTestTree();
      const secondChildId = tree.root.children[1].id;
      const result = TreeOperations.moveNodeUp(tree, secondChildId);
      
      expect(result.success).toBe(true);
      expect(result.tree.root.children[0].id).toBe(secondChildId);
    });

    it("should move nodes down", () => {
      const tree = createTestTree();
      const firstChildId = tree.root.children[0].id;
      const result = TreeOperations.moveNodeDown(tree, firstChildId);
      
      expect(result.success).toBe(true);
      expect(result.tree.root.children[1].id).toBe(firstChildId);
    });

    it("should delete nodes", () => {
      const tree = createTestTree();
      const child1Id = tree.root.children[0].id;
      const result = TreeOperations.deleteNode(tree, child1Id);
      
      expect(result.success).toBe(true);
      expect(result.tree.root.children).toHaveLength(1);
      expect(result.tree.blocks).toHaveLength(1);
      expect(result.tree.blocks[0].id).toBe(tree.root.children[1].id);
    });
  });

  describe("Markdown Parsing", () => {
    function parseMarkdownToTree(markdown: string): Tree {
      if (!markdown.trim()) return TreeOperations.createEmptyTree();

      const lines = markdown.split("\n");
      const blocks: Block[] = [];
      const stack: Array<{ nodeId: string; level: number }> = [];
      const nodeChildren = new Map<string, string[]>();
      const rootChildren: string[] = [];

      for (const line of lines) {
        const match = line.match(/^(\s*)-\s(.+)$/);
        if (!match) continue;

        const [, indent, content] = match;
        const level = Math.floor(indent.length / 2);
        const nodeId = TreeOperations.createId();
        
        // Create block for this content
        const block = TreeOperations.createBlock({ id: nodeId, body: content });
        blocks.push(block);

        // Remove items from stack that are at same or deeper level
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }

        if (stack.length === 0) {
          // This is a root level node
          rootChildren.push(nodeId);
        } else {
          // Add as child of the parent
          const parentId = stack[stack.length - 1].nodeId;
          if (!nodeChildren.has(parentId)) {
            nodeChildren.set(parentId, []);
          }
          nodeChildren.get(parentId)!.push(nodeId);
        }

        stack.push({ nodeId, level });
      }

      // Build the node tree
      const buildNode = (nodeId: string): Node => {
        const children = nodeChildren.get(nodeId) || [];
        return {
          id: nodeId,
          children: children.map(buildNode),
        };
      };

      const root = {
        id: TreeOperations.createId(),
        children: rootChildren.map(buildNode)
      };

      return {
        root,
        blocks,
        attachments: [],
      };
    }

    it("parses simple list correctly", () => {
      const markdown = "- Item 1\n- Item 2\n- Item 3";
      const tree = parseMarkdownToTree(markdown);

      expect(tree.root.children).toHaveLength(3);
      expect(tree.blocks).toHaveLength(3);
      expect(tree.blocks[0].body).toBe("Item 1");
      expect(tree.blocks[1].body).toBe("Item 2");
      expect(tree.blocks[2].body).toBe("Item 3");
    });

    it("parses nested list correctly", () => {
      const markdown = "- Parent\n  - Child 1\n  - Child 2\n- Parent 2";
      const tree = parseMarkdownToTree(markdown);

      expect(tree.root.children).toHaveLength(2);
      const parentBlock = tree.blocks.find(b => b.body === "Parent");
      expect(parentBlock).toBeTruthy();
      
      const parentNode = TreeOperations.findNode(tree.root, parentBlock!.id);
      expect(parentNode!.children).toHaveLength(2);
      
      const child1Block = tree.blocks.find(b => b.body === "Child 1");
      const child2Block = tree.blocks.find(b => b.body === "Child 2");
      expect(child1Block).toBeTruthy();
      expect(child2Block).toBeTruthy();
    });

    it("handles deep nesting", () => {
      const markdown = "- Level 0\n  - Level 1\n    - Level 2\n      - Level 3";
      const tree = parseMarkdownToTree(markdown);

      expect(tree.root.children).toHaveLength(1);
      const level0Node = tree.root.children[0];
      expect(level0Node.children).toHaveLength(1);
      
      const level1Node = level0Node.children[0];
      expect(level1Node.children).toHaveLength(1);
      
      const level2Node = level1Node.children[0];
      expect(level2Node.children).toHaveLength(1);
      
      const level3Node = level2Node.children[0];
      expect(level3Node.children).toHaveLength(0);
      
      const level0Block = tree.blocks.find(b => b.body === "Level 0");
      const level3Block = tree.blocks.find(b => b.body === "Level 3");
      expect(level0Block).toBeTruthy();
      expect(level3Block).toBeTruthy();
    });
  });

  describe("Markdown Generation", () => {
    it("converts simple tree to markdown", () => {
      const child1Id = TreeOperations.createId();
      const child2Id = TreeOperations.createId();
      
      const tree: Tree = {
        root: {
          id: TreeOperations.createId(),
          children: [
            { id: child1Id, children: [] },
            { id: child2Id, children: [] }
          ]
        },
        blocks: [
          { id: child1Id, body: "Item 1", attachments: [] },
          { id: child2Id, body: "Item 2", attachments: [] }
        ],
        attachments: []
      };

      const markdown = TreeOperations.toMarkdown(tree);
      expect(markdown).toBe("- Item 1\n- Item 2");
    });

    it("converts nested tree to markdown", () => {
      const parentId = TreeOperations.createId();
      const child1Id = TreeOperations.createId();
      const child2Id = TreeOperations.createId();
      
      const tree: Tree = {
        root: {
          id: TreeOperations.createId(),
          children: [
            { 
              id: parentId, 
              children: [
                { id: child1Id, children: [] },
                { id: child2Id, children: [] }
              ]
            }
          ]
        },
        blocks: [
          { id: parentId, body: "Parent", attachments: [] },
          { id: child1Id, body: "Child 1", attachments: [] },
          { id: child2Id, body: "Child 2", attachments: [] }
        ],
        attachments: []
      };

      const markdown = TreeOperations.toMarkdown(tree);
      expect(markdown).toBe("- Parent\n  - Child 1\n  - Child 2");
    });
  });

  describe("Node Navigation Logic", () => {
    it("gets all visible nodes", () => {
      const tree = TreeOperations.createEmptyTree();
      const child1Id = TreeOperations.createId();
      const child2Id = TreeOperations.createId();
      
      const updatedTree: Tree = {
        ...tree,
        root: {
          ...tree.root,
          children: [
            { id: child1Id, children: [] },
            { id: child2Id, children: [] }
          ]
        },
        blocks: [
          { id: child1Id, body: "Item 1", attachments: [] },
          { id: child2Id, body: "Item 2", attachments: [] }
        ]
      };

      const collapsedNodes = new Set<string>();
      const visibleNodes = TreeOperations.getAllVisibleNodes(updatedTree.root, collapsedNodes);
      
      expect(visibleNodes).toHaveLength(2);
      expect(visibleNodes[0].id).toBe(child1Id);
      expect(visibleNodes[1].id).toBe(child2Id);
    });

    it("respects collapsed state", () => {
      const parentId = TreeOperations.createId();
      const childId = TreeOperations.createId();
      
      const tree: Tree = {
        root: {
          id: TreeOperations.createId(),
          children: [
            { 
              id: parentId, 
              children: [
                { id: childId, children: [] }
              ]
            }
          ]
        },
        blocks: [
          { id: parentId, body: "Parent", attachments: [] },
          { id: childId, body: "Child", attachments: [] }
        ],
        attachments: []
      };

      const collapsedNodes = new Set([parentId]);
      const visibleNodes = TreeOperations.getAllVisibleNodes(tree.root, collapsedNodes);
      
      expect(visibleNodes).toHaveLength(1);
      expect(visibleNodes[0].id).toBe(parentId);
    });
  });
});