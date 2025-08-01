/**
 * Shared test utilities for CT Outliner component tests
 */
import { CTOutliner } from "./ct-outliner.ts";
import type { KeyboardContext, Tree } from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";
import { type Cell } from "@commontools/runner";

// Mock runtime for creating test Cells
class MockRuntime {
  edit() {
    return {
      commit: () => {},
    };
  }
}

// Mock Cell implementation for testing
// @ts-ignore
class MockCell<T> implements Partial<Cell<T>> {
  private value: T;
  private parent?: MockCell<any>;
  private keyInParent?: string | number;
  runtime = new MockRuntime() as any;
  space = "test" as any;

  constructor(value: T, parent?: MockCell<any>, keyInParent?: string | number) {
    this.value = value;
    this.parent = parent;
    this.keyInParent = keyInParent;
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    // Update parent if this is a nested cell
    if (this.parent && this.keyInParent !== undefined) {
      const parentValue = this.parent.get() as any;
      if (parentValue && typeof parentValue === 'object') {
        parentValue[this.keyInParent] = value;
        this.parent.set(parentValue);
      }
    }
  }

  key(key: string | number): any {
    const currentValue = this.get() as any;
    if (currentValue && typeof currentValue === 'object' && key in currentValue) {
      return new MockCell(currentValue[key], this, key);
    }
    return new MockCell(undefined, this, key);
  }

  withTx(tx: any): any {
    // For testing, create a new instance that behaves the same
    return new MockCell(this.value, this.parent, this.keyInParent);
  }

  push(...items: any[]): void {
    if (Array.isArray(this.value)) {
      (this.value as any[]).push(...items);
    }
  }

  sink(callback: (value: any) => void): () => void {
    // Mock subscription
    return () => {};
  }

  equals(other: any): boolean {
    return this === other;
  }

  // Add other required Cell methods as no-ops
  [Symbol.iterator]() {
    return [][Symbol.iterator]();
  }
}

/**
 * Create a mock Cell for a tree structure
 */
export const createMockTreeCell = (tree: Tree): Cell<Tree> => {
  return new MockCell(tree) as any;
};

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
export const createTestTree = () => ({
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
export const createNestedTestTree = () => ({
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
  const treeCell = createMockTreeCell(tree);
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
