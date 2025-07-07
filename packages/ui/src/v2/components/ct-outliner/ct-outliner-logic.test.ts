import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TreeOperations } from "./tree-operations.ts";
import { KeyboardCommands } from "./keyboard-commands.ts";
import { createNestedTestTree, createTestTree } from "./test-utils.ts";
import type { Node, Tree } from "./types.ts";

// Test the core logic without DOM dependencies
describe("CTOutliner Logic Tests", () => {
  // Test Tree structure and TreeOperations
  describe("Tree Operations", () => {
    it("should create empty tree", () => {
      const tree = TreeOperations.createEmptyTree();
      expect(tree.root.children).toHaveLength(0);
      expect(tree.root.body).toBe("");
      expect(tree.root.attachments).toHaveLength(0);
    });

    it("should find nodes by reference", () => {
      const tree = createTestTree();
      const child1 = tree.root.children[0];
      const foundNode = TreeOperations.findNode(tree.root, child1);
      expect(foundNode).toBe(child1);
    });

    it("should update node content", () => {
      const tree = createTestTree();
      const node = tree.root.children[0];
      const updatedTree = TreeOperations.updateNodeBody(
        tree,
        node,
        "Updated content",
      );
      const updatedNode = updatedTree.root.children[0];
      expect(updatedNode.body).toBe("Updated content");
    });

    it("should move nodes up", () => {
      const tree = createTestTree();
      const secondChild = tree.root.children[1];
      const result = TreeOperations.moveNodeUp(tree, secondChild);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tree.root.children[0].body).toBe("Second item");
        expect(result.data.tree.root.children[1].body).toBe("First item");
      }
    });

    it("should move nodes down", () => {
      const tree = createTestTree();
      const firstChild = tree.root.children[0];
      const result = TreeOperations.moveNodeDown(tree, firstChild);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tree.root.children[0].body).toBe("Second item");
        expect(result.data.tree.root.children[1].body).toBe("First item");
      }
    });

    it("should delete nodes", () => {
      const tree = createTestTree();
      const child1 = tree.root.children[0];
      const result = TreeOperations.deleteNode(tree, child1);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tree.root.children).toHaveLength(1);
        expect(result.data.tree.root.children[0].body).toBe("Second item");
      }
    });

    it("should handle transformTree utility", () => {
      const tree = createTestTree();
      const firstChild = tree.root.children[0];

      const result = TreeOperations.transformTree(
        tree,
        (node) => node === firstChild,
        (node) => ({ ...node, body: "Transformed" }),
      );

      expect(result.root.children[0].body).toBe("Transformed");
      expect(result.root.children[1].body).toBe("Second item");
    });

    it("should indent nodes", () => {
      const tree = createTestTree();
      const secondChild = tree.root.children[1];
      const result = TreeOperations.indentNode(tree, secondChild);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tree.root.children).toHaveLength(1);
        expect(result.data.tree.root.children[0].children).toHaveLength(1);
        expect(result.data.tree.root.children[0].children[0].body).toBe(
          "Second item",
        );
      }
    });

    it("should outdent nodes", () => {
      const tree: Tree = {
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

      const childNode = tree.root.children[0].children[0];
      const result = TreeOperations.outdentNode(tree, childNode);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tree.root.children).toHaveLength(2);
        expect(result.data.tree.root.children[1].body).toBe("Child");
      }
    });

    it("should convert to markdown", () => {
      const tree: Tree = {
        root: {
          body: "",
          children: [{
            body: "Item 1",
            children: [{
              body: "Sub-item 1.1",
              children: [],
              attachments: [],
            }],
            attachments: [],
          }, {
            body: "Item 2",
            children: [],
            attachments: [],
          }],
          attachments: [],
        },
      };

      const markdown = TreeOperations.toMarkdown(tree);
      expect(markdown).toBe("- Item 1\n  - Sub-item 1.1\n- Item 2");
    });

    it("should parse markdown to tree", () => {
      const markdown = "- Item 1\n  - Sub-item 1.1\n- Item 2";
      const tree = TreeOperations.parseMarkdownToTree(markdown);

      expect(tree.root.children).toHaveLength(2);
      expect(tree.root.children[0].body).toBe("Item 1");
      expect(tree.root.children[0].children).toHaveLength(1);
      expect(tree.root.children[0].children[0].body).toBe("Sub-item 1.1");
      expect(tree.root.children[1].body).toBe("Item 2");
    });

    it("should get all nodes", () => {
      const tree = createTestTree();
      const allNodes = TreeOperations.getAllNodes(tree.root);

      expect(allNodes).toHaveLength(3); // root + 2 children
      expect(allNodes[0]).toBe(tree.root);
      expect(allNodes[1]).toBe(tree.root.children[0]);
      expect(allNodes[2]).toBe(tree.root.children[1]);
    });

    it("should get visible nodes respecting collapsed state", () => {
      const tree: Tree = {
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
          }, {
            body: "Item 2",
            children: [],
            attachments: [],
          }],
          attachments: [],
        },
      };

      const parentNode = tree.root.children[0];
      const collapsedNodes = new Set([parentNode]);
      const visibleNodes = TreeOperations.getAllVisibleNodes(
        tree.root,
        collapsedNodes,
      );

      expect(visibleNodes).toHaveLength(2); // Parent and Item 2 (Child is hidden)
      expect(visibleNodes[0]).toBe(parentNode);
      expect(visibleNodes[1]).toBe(tree.root.children[1]);
    });

    it("should find parent node", () => {
      const tree: Tree = {
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

      const childNode = tree.root.children[0].children[0];
      const parent = TreeOperations.findParentNode(tree.root, childNode);

      expect(parent).toBe(tree.root.children[0]);
    });

    it("should insert node at specific index", () => {
      const tree = createTestTree();
      const newNode = TreeOperations.createNode({ body: "New item" });
      const updatedTree = TreeOperations.insertNode(
        tree,
        tree.root,
        newNode,
        1,
      );

      expect(updatedTree.root.children).toHaveLength(3);
      expect(updatedTree.root.children[0].body).toBe("First item");
      expect(updatedTree.root.children[1].body).toBe("New item");
      expect(updatedTree.root.children[2].body).toBe("Second item");
    });

    it("should find node path", () => {
      const tree: Tree = {
        root: {
          body: "",
          children: [{
            body: "Parent",
            children: [{
              body: "Child",
              children: [{
                body: "Grandchild",
                children: [],
                attachments: [],
              }],
              attachments: [],
            }],
            attachments: [],
          }],
          attachments: [],
        },
      };

      const grandchild = tree.root.children[0].children[0].children[0];
      const path = TreeOperations.findNodePath(tree.root, grandchild);

      expect(path).toHaveLength(4);
      expect(path![0]).toBe(tree.root);
      expect(path![1]).toBe(tree.root.children[0]);
      expect(path![2]).toBe(tree.root.children[0].children[0]);
      expect(path![3]).toBe(grandchild);
    });
  });

  // Test keyboard command logic
  describe("Keyboard Commands", () => {
    it("should have arrow navigation commands", () => {
      expect(KeyboardCommands.ArrowUp).toBeDefined();
      expect(KeyboardCommands.ArrowDown).toBeDefined();
      expect(KeyboardCommands.ArrowLeft).toBeDefined();
      expect(KeyboardCommands.ArrowRight).toBeDefined();
    });

    it("should have editing commands", () => {
      expect(KeyboardCommands.Enter).toBeDefined();
      expect(KeyboardCommands[" "]).toBeDefined();
      expect(KeyboardCommands.Delete).toBeDefined();
    });

    it("should have tree manipulation commands", () => {
      expect(KeyboardCommands.Tab).toBeDefined();
    });

    it("should have clipboard commands", () => {
      expect(KeyboardCommands.c).toBeDefined();
    });

    it("should have node creation commands", () => {
      expect(KeyboardCommands.n).toBeDefined();
    });
  });

  // Test node operations preserve tree integrity
  describe("Tree Integrity", () => {
    it("should preserve children when deleting node with children", () => {
      const tree: Tree = {
        root: {
          body: "",
          children: [{
            body: "Parent",
            children: [{
              body: "Child 1",
              children: [],
              attachments: [],
            }, {
              body: "Child 2",
              children: [],
              attachments: [],
            }],
            attachments: [],
          }],
          attachments: [],
        },
      };

      const parentNode = tree.root.children[0];
      const result = TreeOperations.deleteNode(tree, parentNode);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tree.root.children).toHaveLength(2);
        expect(result.data.tree.root.children[0].body).toBe("Child 1");
        expect(result.data.tree.root.children[1].body).toBe("Child 2");
      }
    });

    it("should not allow deleting root node", () => {
      const tree = createTestTree();
      const result = TreeOperations.deleteNode(tree, tree.root);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Cannot delete root node");
      }
    });

    it("should not indent first child", () => {
      const tree = createTestTree();
      const firstChild = tree.root.children[0];
      const result = TreeOperations.indentNode(tree, firstChild);

      expect(result.success).toBe(false);
    });

    it("should not outdent root-level nodes", () => {
      const tree = createTestTree();
      const firstChild = tree.root.children[0];
      const result = TreeOperations.outdentNode(tree, firstChild);

      expect(result.success).toBe(false);
    });
  });
});
