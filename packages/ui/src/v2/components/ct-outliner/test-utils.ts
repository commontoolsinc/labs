/**
 * Shared test utilities for CT Outliner component tests
 */
import { CTOutliner } from "./ct-outliner.ts";
import type { KeyboardContext, Tree } from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";
import { type Cell, Runtime, toOpaqueRef } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

/**
 * Create a real Cell for a tree structure using a fresh runtime
 * This is the async version that should be preferred when possible
 */
export const createMockTreeCellAsync = async (tree: Tree): Promise<Cell<Tree>> => {
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
  root: {
    body: "",
    children: [
      { body: "First item", children: [], attachments: [] },
      { body: "Second item", children: [], attachments: [] },
    ],
    attachments: [],
  },
});

/**
 * Create a nested test tree structure
 */
export const createNestedTestTree = (): Tree => ({
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
  // Set focused node to the one from the outliner's tree, not the original tree
  outliner.focusedNode = outliner.tree.root.children[0];

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
  const currentIndex = outliner.focusedNode
    ? allNodes.indexOf(outliner.focusedNode)
    : -1;

  return {
    event,
    component: outliner,
    allNodes,
    currentIndex,
    focusedNode: outliner.focusedNode,
  };
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
  await new Promise(resolve => setTimeout(resolve, 10));
};

/**
 * Wait for Cell updates to propagate by observing an outliner
 * This waits for the outliner's Cell to actually update and trigger the sink
 */
export const waitForOutlinerUpdate = (outliner: CTOutliner): Promise<void> => {
  if (!outliner.value) {
    return Promise.resolve();
  }
  
  const cell = outliner.value;
  
  return new Promise(resolve => {
    let unsubscribe: (() => void) | null = null;
    
    // Set up a one-time listener for the next Cell update
    unsubscribe = cell.sink(() => {
      if (unsubscribe) {
        unsubscribe();
      }
      resolve();
    });
    
    // Fallback timeout in case the update doesn't come
    setTimeout(() => {
      if (unsubscribe) {
        unsubscribe();
      }
      resolve();
    }, 100);
  });
};