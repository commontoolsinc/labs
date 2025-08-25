/**
 * Shared test utilities for CT Outliner component tests
 */
import { CTOutliner } from "./ct-outliner.ts";
import type {
  KeyboardContext,
  Node,
  PathBasedKeyboardContext,
  Tree,
} from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";
import { getNodeByPath } from "./node-path.ts";
import { type Cell, Runtime, toOpaqueRef } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

/**
 * Create a real Cell for a tree structure using a fresh runtime
 * This is the async version that should be preferred when possible
 */
export const createMockTreeCellAsync = async (
  tree: Tree,
): Promise<Cell<Tree>> => {
  const signer = await Identity.fromPassphrase("test-outliner-user");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });

  const runtime = new Runtime({
    storageManager,
    blobbyServerUrl: import.meta.url,
  });

  const tx = runtime.edit();
  const cell = runtime.getCell<Tree>(space as any, "test-tree", undefined, tx);
  cell.set(tree);
  await tx.commit();
  return cell;
};

/**
 * Create a mock tree cell using real Cells from @commontools/runner
 * This is the preferred method for all new and existing tests
 */
export const createMockTreeCell = createMockTreeCellAsync;

/**
 * Mock DOM element for testing
 */
export const createMockElement = (tagName: string) => ({
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

/**
 * Mock shadow root for testing
 */
export const createMockShadowRoot = () => ({
  querySelector: (selector: string) => {
    if (selector.includes("editor-")) return createMockElement("textarea");
    if (selector === ".outliner") return createMockElement("div");
    return null;
  },
});

/**
 * Create a standard test tree structure
 */
export const createTestTree = (): Tree => ({
  root: TreeOperations.createNode({
    body: "",
    children: [
      TreeOperations.createNode({ body: "First item" }),
      TreeOperations.createNode({ body: "Second item" }),
    ],
  }),
});

/**
 * Create a nested test tree structure
 */
export const createNestedTestTree = (): Tree => ({
  root: TreeOperations.createNode({
    body: "",
    children: [
      TreeOperations.createNode({
        body: "Parent",
        children: [
          TreeOperations.createNode({ body: "Child" }),
        ],
      }),
    ],
  }),
});

/**
 * Async version of setupMockOutliner that uses real Cells
 * This is the preferred version for new tests
 */
export const setupMockOutlinerAsync = async () => {
  const outliner = new CTOutliner();

  // Mock the shadowRoot
  Object.defineProperty(outliner, "shadowRoot", {
    value: createMockShadowRoot(),
    writable: false,
  });

  // Setup basic tree with real Cell
  const tree = createTestTree();
  const treeCell = await createMockTreeCellAsync(tree);
  outliner.value = treeCell;
  // Set focused node path to the first child
  outliner.focusedNodePath = [0];

  return { outliner, tree, treeCell };
};

/**
 * Setup outliner with mock DOM and basic tree
 * Uses real Cells for consistent behavior
 */
export const setupMockOutliner = setupMockOutlinerAsync;

/**
 * Create mock keyboard event
 */
export const createMockKeyboardEvent = (
  key: string,
  modifiers: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  } = {},
): KeyboardEvent => ({
  key,
  ctrlKey: modifiers.ctrlKey || false,
  metaKey: modifiers.metaKey || false,
  shiftKey: modifiers.shiftKey || false,
  altKey: modifiers.altKey || false,
  preventDefault: () => {},
  stopPropagation: () => {},
} as KeyboardEvent);

/**
 * Create keyboard context for testing
 */
export const createKeyboardContext = (
  event: KeyboardEvent,
  outliner: CTOutliner,
): KeyboardContext => {
  const allNodes = TreeOperations.getAllVisibleNodes(
    outliner.tree.root,
    new Set(),
  );
  const focusedNode = outliner.focusedNodePath
    ? getNodeByPath(outliner.tree, outliner.focusedNodePath)
    : null;
  const currentIndex = focusedNode ? allNodes.indexOf(focusedNode) : -1;

  return {
    event,
    component: outliner,
    allNodes,
    currentIndex,
    focusedNode: focusedNode,
  };
};

/**
 * Create path-based keyboard context for testing
 */
export const createPathBasedKeyboardContext = (
  event: KeyboardEvent,
  outliner: CTOutliner,
): PathBasedKeyboardContext => {
  const allNodes = TreeOperations.getAllVisibleNodes(
    outliner.tree.root,
    new Set(),
  );
  const focusedNode = outliner.focusedNodePath
    ? getNodeByPath(outliner.tree, outliner.focusedNodePath)
    : null;

  // Find current index by comparing node content instead of object identity
  // since Cell-based nodes might have different proxy references
  let currentIndex = -1;
  if (focusedNode) {
    // Try to find the node by matching body content
    for (let i = 0; i < allNodes.length; i++) {
      if (allNodes[i].body === focusedNode.body) {
        currentIndex = i;
        break;
      }
    }
  }

  return {
    event,
    component: outliner,
    allNodes,
    currentIndex,
    focusedNodePath: outliner.focusedNodePath,
  };
};

/**
 * Get all visible node paths from a tree
 */
export const getAllVisibleNodePaths = (tree: Tree): number[][] => {
  const paths: number[][] = [];

  const traverse = (node: Node, currentPath: number[]) => {
    // Add current path if not root (root is at empty path)
    if (currentPath.length > 0) {
      paths.push([...currentPath]);
    }

    // Traverse children
    if (node.children && node.children.length > 0) {
      node.children.forEach((child, index) => {
        traverse(child, [...currentPath, index]);
      });
    }
  };

  traverse(tree.root, []);
  return paths;
};

/**
 * Create mock textarea for editing tests
 */
export const createMockTextarea = (
  content: string,
  cursorPosition: number = 0,
) => ({
  selectionStart: cursorPosition,
  selectionEnd: cursorPosition,
  value: content,
} as HTMLTextAreaElement);

/**
 * Wait for Cell updates to propagate
 * This helps tests wait for async Cell operations to complete
 */
export const waitForCellUpdate = async (): Promise<void> => {
  // Wait for async Cell operations to complete
  // We need to wait longer than just a microtask since Cell operations
  // involve database transactions that are truly async
  await new Promise((resolve) => setTimeout(resolve, 10));
};

/**
 * Wait for Cell updates to propagate by observing an outliner
 * This waits for the outliner's Cell to actually update and trigger the sink
 */
export const waitForOutlinerUpdate = async (
  outliner: CTOutliner,
): Promise<void> => {
  // Since tree operations use transactions and await tx.commit(),
  // they should be synchronous by the time they return.
  // We just need a small delay to let any microtasks complete.
  await new Promise((resolve) => setTimeout(resolve, 0));
};
