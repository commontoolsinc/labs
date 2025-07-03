import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TreeOperations } from "./tree-operations.ts";
import { KeyboardCommands } from "./keyboard-commands.ts";
import type { Tree, Node, Block } from "./types.ts";

// Test helper function
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

// Test the core logic without DOM dependencies
describe("CTOutliner Logic Tests", () => {
  // Test Tree structure and TreeOperations
  describe("Tree Operations", () => {

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

    it("should handle transformTree utility", () => {
      const tree = createTestTree();
      const firstChildId = tree.root.children[0].id;
      
      const result = TreeOperations.transformTree(
        tree,
        (node) => node.id === firstChildId,
        (node) => ({ ...node, children: [{ id: "new-child", children: [] }] })
      );
      
      const transformedNode = TreeOperations.findNode(result.root, firstChildId);
      expect(transformedNode!.children).toHaveLength(1);
      expect(transformedNode!.children[0].id).toBe("new-child");
    });

    it("should determine focus after deletion correctly", () => {
      const tree = createTestTree();
      const parentNode = tree.root;
      
      // Test with middle index (should focus previous)
      const newFocusId = TreeOperations.determineFocusAfterDeletion(tree, parentNode, 1);
      expect(newFocusId).toBe(tree.root.children[0].id);
      
      // Test with first index (should focus next)
      const newFocusId2 = TreeOperations.determineFocusAfterDeletion(tree, parentNode, 0);
      expect(newFocusId2).toBe(tree.root.children[1].id);
    });

    it("should add and remove blocks", () => {
      const tree = createTestTree();
      const newBlock = TreeOperations.createBlock({ body: "New block" });
      
      // Add block
      const updatedTree = TreeOperations.addBlock(tree, newBlock);
      expect(updatedTree.blocks).toHaveLength(3);
      expect(TreeOperations.findBlock(updatedTree, newBlock.id)).toBeTruthy();
      
      // Remove block
      const removedTree = TreeOperations.removeBlock(updatedTree, newBlock.id);
      expect(removedTree.blocks).toHaveLength(2);
      expect(TreeOperations.findBlock(removedTree, newBlock.id)).toBeNull();
    });

    it("should insert and remove nodes", () => {
      const tree = createTestTree();
      const newNode = TreeOperations.createNode({ id: "new-node" });
      const parentId = tree.root.id;
      
      // Insert node
      const insertedTree = TreeOperations.insertNode(tree, parentId, newNode, 1);
      expect(insertedTree.root.children).toHaveLength(3);
      expect(insertedTree.root.children[1].id).toBe("new-node");
      
      // Remove node
      const removedTree = TreeOperations.removeNode(insertedTree, "new-node");
      expect(removedTree.root.children).toHaveLength(2);
      expect(TreeOperations.findNode(removedTree.root, "new-node")).toBeNull();
    });

    it("should handle indent/outdent operations", () => {
      const tree = createTestTree();
      const secondChildId = tree.root.children[1].id;
      
      // Test indent (make second child a child of first)
      const indentResult = TreeOperations.indentNode(tree, secondChildId);
      expect(indentResult.success).toBe(true);
      expect(indentResult.tree.root.children).toHaveLength(1);
      expect(indentResult.tree.root.children[0].children).toHaveLength(1);
      expect(indentResult.tree.root.children[0].children[0].id).toBe(secondChildId);
      
      // Test outdent (move it back)
      const outdentResult = TreeOperations.outdentNode(indentResult.tree, secondChildId);
      expect(outdentResult.success).toBe(true);
      expect(outdentResult.tree.root.children).toHaveLength(2);
    });

    it("should handle getAllNodes", () => {
      const tree = createTestTree();
      const allNodes = TreeOperations.getAllNodes(tree.root);
      
      // Should include root + 2 children
      expect(allNodes).toHaveLength(3);
      expect(allNodes[0]).toBe(tree.root);
      expect(allNodes[1]).toBe(tree.root.children[0]);
      expect(allNodes[2]).toBe(tree.root.children[1]);
    });

    it("should handle getNodeIndex", () => {
      const tree = createTestTree();
      const parentNode = tree.root;
      const firstChildId = tree.root.children[0].id;
      const secondChildId = tree.root.children[1].id;
      
      expect(TreeOperations.getNodeIndex(parentNode, firstChildId)).toBe(0);
      expect(TreeOperations.getNodeIndex(parentNode, secondChildId)).toBe(1);
      expect(TreeOperations.getNodeIndex(parentNode, "nonexistent")).toBe(-1);
    });

    it("should handle findParentNode", () => {
      const tree = createTestTree();
      const firstChildId = tree.root.children[0].id;
      
      const parent = TreeOperations.findParentNode(tree.root, firstChildId);
      expect(parent).toBe(tree.root);
      
      const nonexistentParent = TreeOperations.findParentNode(tree.root, "nonexistent");
      expect(nonexistentParent).toBeNull();
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle movement operations on invalid nodes", () => {
      const tree = TreeOperations.createEmptyTree();
      
      // Try to move nonexistent node
      const moveUpResult = TreeOperations.moveNodeUp(tree, "nonexistent");
      expect(moveUpResult.success).toBe(false);
      
      const moveDownResult = TreeOperations.moveNodeDown(tree, "nonexistent");
      expect(moveDownResult.success).toBe(false);
    });

    it("should handle first/last node movement restrictions", () => {
      const tree = createTestTree();
      const firstChildId = tree.root.children[0].id;
      const lastChildId = tree.root.children[1].id;
      
      // Can't move first node up
      const moveUpFirst = TreeOperations.moveNodeUp(tree, firstChildId);
      expect(moveUpFirst.success).toBe(false);
      
      // Can't move last node down
      const moveDownLast = TreeOperations.moveNodeDown(tree, lastChildId);
      expect(moveDownLast.success).toBe(false);
    });

    it("should handle indent/outdent restrictions", () => {
      const tree = createTestTree();
      const firstChildId = tree.root.children[0].id;
      
      // Can't indent first child (no previous sibling)
      const indentFirst = TreeOperations.indentNode(tree, firstChildId);
      expect(indentFirst.success).toBe(false);
      
      // Can't outdent root-level node (no grandparent)
      const outdentRoot = TreeOperations.outdentNode(tree, firstChildId);
      expect(outdentRoot.success).toBe(false);
    });

    it("should handle deleteNode restrictions", () => {
      const tree = TreeOperations.createEmptyTree();
      
      // Can't delete root node
      const deleteRoot = TreeOperations.deleteNode(tree, tree.root.id);
      expect(deleteRoot.success).toBe(false);
      
      // Can't delete nonexistent node
      const deleteNonexistent = TreeOperations.deleteNode(tree, "nonexistent");
      expect(deleteNonexistent.success).toBe(false);
    });

    it("should handle deleteNode with children (promoting children)", () => {
      // Create tree with grandchildren
      const grandChildId = TreeOperations.createId();
      const childId = TreeOperations.createId();
      const parentId = TreeOperations.createId();
      
      const tree: Tree = {
        root: {
          id: TreeOperations.createId(),
          children: [{
            id: parentId,
            children: [{
              id: childId,
              children: [{
                id: grandChildId,
                children: []
              }]
            }]
          }]
        },
        blocks: [
          { id: parentId, body: "Parent", attachments: [] },
          { id: childId, body: "Child", attachments: [] },
          { id: grandChildId, body: "Grandchild", attachments: [] }
        ],
        attachments: []
      };
      
      // Delete the middle child - grandchild should be promoted
      const result = TreeOperations.deleteNode(tree, childId);
      expect(result.success).toBe(true);
      
      const parentNode = TreeOperations.findNode(result.tree.root, parentId);
      expect(parentNode!.children).toHaveLength(1);
      expect(parentNode!.children[0].id).toBe(grandChildId);
    });

    it("should handle empty tree operations", () => {
      const emptyTree = TreeOperations.createEmptyTree();
      
      // Should handle operations on empty tree gracefully
      const visibleNodes = TreeOperations.getAllVisibleNodes(emptyTree.root, new Set());
      expect(visibleNodes).toHaveLength(0);
      
      const markdown = TreeOperations.toMarkdown(emptyTree);
      expect(markdown).toBe("");
      
      const nonexistentBlock = TreeOperations.findBlock(emptyTree, "nonexistent");
      expect(nonexistentBlock).toBeNull();
      
      const nonexistentNode = TreeOperations.findNode(emptyTree.root, "nonexistent");
      expect(nonexistentNode).toBeNull();
    });

    it("should handle transformTree with no matching nodes", () => {
      const tree = createTestTree();
      
      const result = TreeOperations.transformTree(
        tree,
        (node) => node.id === "nonexistent",
        (node) => ({ ...node, children: [] })
      );
      
      // Tree should be unchanged
      expect(result).toEqual(tree);
    });

    it("should create consistent IDs", () => {
      const id1 = TreeOperations.createId();
      const id2 = TreeOperations.createId();
      
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe("string");
      expect(typeof id2).toBe("string");
    });

    it("should handle focus determination edge cases", () => {
      const tree = createTestTree();
      const parentNode = tree.root;
      
      // Test with out-of-bounds index (should still find a valid focus)
      const focusId = TreeOperations.determineFocusAfterDeletion(tree, parentNode, 99);
      expect(focusId).toBeTruthy(); // Should fall back to first visible node
      
      // Test with empty tree structure (no children)
      const emptyTree = TreeOperations.createEmptyTree();
      const emptyParent: Node = { id: "empty", children: [] };
      const focusId2 = TreeOperations.determineFocusAfterDeletion(emptyTree, emptyParent, 0);
      expect(focusId2).toBeNull();
    });

    it("should handle complex nested operations", () => {
      // Create a deeper tree structure
      const level3Id = TreeOperations.createId();
      const level2Id = TreeOperations.createId();
      const level1Id = TreeOperations.createId();
      
      const complexTree: Tree = {
        root: {
          id: TreeOperations.createId(),
          children: [{
            id: level1Id,
            children: [{
              id: level2Id,
              children: [{
                id: level3Id,
                children: []
              }]
            }]
          }]
        },
        blocks: [
          { id: level1Id, body: "Level 1", attachments: [] },
          { id: level2Id, body: "Level 2", attachments: [] },
          { id: level3Id, body: "Level 3", attachments: [] }
        ],
        attachments: []
      };
      
      // Test deep node operations
      const allNodes = TreeOperations.getAllNodes(complexTree.root);
      expect(allNodes).toHaveLength(4); // root + 3 levels
      
      // Test find operations at depth
      const level3Node = TreeOperations.findNode(complexTree.root, level3Id);
      expect(level3Node).toBeTruthy();
      expect(level3Node!.children).toHaveLength(0);
      
      const level2Parent = TreeOperations.findParentNode(complexTree.root, level3Id);
      expect(level2Parent!.id).toBe(level2Id);
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