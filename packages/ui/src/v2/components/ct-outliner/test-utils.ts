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
 * Create a synchronous mock cell that behaves like a real cell
 * This maintains the existing test interface while providing better behavior than the old MockCell
 */
export const createMockTreeCellSync = (initialTree: Tree): Cell<Tree> => {
  // Use a mutable container that can be updated
  const container = { value: initialTree };
  
  // Helper function to create a subcell for any path within the container
  function createPathCell(path: (string | number)[]): Cell<any> {
    return {
      get: () => {
        let current = container.value;
        for (const key of path) {
          current = (current as any)[key];
          if (current === undefined) break;
        }
        return current;
      },
      set: (newValue: any) => {
        if (path.length === 0) {
          container.value = newValue;
          return;
        }
        
        let current = container.value as any;
        for (let i = 0; i < path.length - 1; i++) {
          current = current[path[i]];
        }
        current[path[path.length - 1]] = newValue;
      },
      key: (key: string | number) => createPathCell([...path, key]),
      send: function(value: any) { this.set(value); },
      update: (values: any) => {
        const current = this.get();
        if (current && typeof current === 'object') {
          Object.assign(current, values);
        }
      },
      push: (...items: any[]) => {
        const current = this.get();
        if (Array.isArray(current)) {
          current.push(...items);
        }
      },
      equals: (other: any) => other === this,
      asSchema: () => this as any,
      withTx: () => this as any,
      sink: () => () => {},
      sync: () => this as any,
      getAsQueryResult: () => this.get() as any,
      getAsNormalizedFullLink: () => ({} as any),
      getAsLink: () => ({} as any),
      getAsWriteRedirectLink: () => ({} as any),
      getDoc: () => ({} as any),
      getRaw: () => this.get(),
      setRaw: (value: any) => this.set(value),
      getSourceCell: () => undefined,
      setSourceCell: () => {},
      freeze: () => {},
      isFrozen: () => false,
      toJSON: () => ({ cell: { "/": "" }, path: [] } as any),
      runtime: {
        edit: () => ({
          commit: () => Promise.resolve(),
        }),
      } as any,
      tx: undefined,
      schema: undefined,
      rootSchema: undefined,
      get value() { return this.get(); },
      cellLink: {} as any,
      space: {} as any,
      entityId: { "/": "" },
      sourceURI: "" as any,
      path: path,
      copyTrap: false,
      [toOpaqueRef]: () => ({} as any),
    } as Cell<any>;
  }
  
  return createPathCell([]);
};

/**
 * For backward compatibility, export createMockTreeCell as the sync version
 * New code should use createMockTreeCellAsync for real cells
 */
export const createMockTreeCell = createMockTreeCellSync;

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
 * Setup outliner with mock DOM and basic tree
 * Uses the sync mock cell for compatibility with existing tests
 */
export const setupMockOutliner = () => {
  const outliner = new CTOutliner();

  // Mock the shadowRoot
  Object.defineProperty(outliner, "shadowRoot", {
    value: createMockShadowRoot(),
    writable: false,
  });

  // Setup basic tree with Cell
  const tree = createTestTree();
  const treeCell = createMockTreeCellSync(tree);
  outliner.value = treeCell;
  outliner.focusedNode = tree.root.children[0];

  return { outliner, tree, treeCell };
};

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
  outliner.focusedNode = tree.root.children[0];

  return { outliner, tree, treeCell };
};

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