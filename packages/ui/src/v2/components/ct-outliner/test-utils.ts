/**
 * Shared test utilities for CT Outliner component tests
 */
import { CTOutliner } from "./ct-outliner.ts";
import type { KeyboardContext } from "./types.ts";
import { TreeOperations } from "./tree-operations.ts";

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

  // Setup basic tree
  const tree = createTestTree();
  outliner.value = tree;
  outliner.focusedNode = tree.root.children[0];

  return { outliner, tree };
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
    outliner.value.root,
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
