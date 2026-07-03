/**
 * Tests for the main-thread DOM applicator.
 *
 * Note: Some tests are still omitted because the mock document here only
 * covers the DOM surface the applicator needs in unit tests.
 */

import {
  assertEquals,
  assertExists,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { createDomApplicator } from "../src/main/applicator.ts";
import type { DomEventMessage } from "../src/main/events.ts";
import type { VDomBatch } from "../src/vdom-ops.ts";
import {
  $conn,
  type CellRef,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

type MockDomEvent = {
  type: string;
  target?: unknown;
  isTrusted?: boolean;
  [key: string]: unknown;
};

type MockDomNode = {
  _id: string;
  nodeType: number;
  tagName: string;
  textContent: string;
  parentNode: MockDomNode | null;
  childNodes: MockDomNode[];
  readonly dataset: Record<string, string>;
  localName?: string;
  requestUpdate?: (name?: PropertyKey) => void;
  cell?: unknown;
  value?: unknown;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  appendChild(child: MockDomNode): MockDomNode;
  insertBefore(child: MockDomNode, reference: MockDomNode | null): MockDomNode;
  removeChild(child: MockDomNode): MockDomNode;
  addEventListener(
    type: string,
    listener: (event: MockDomEvent) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: MockDomEvent) => void,
  ): void;
  dispatchEvent(event: MockDomEvent): void;
};

function mockNode(node: Node | null | undefined): MockDomNode {
  assertExists(node);
  return node as unknown as MockDomNode;
}

function constructorName(value: unknown): string | undefined {
  return typeof value === "object" && value !== null
    ? value.constructor.name
    : undefined;
}

// Mock RuntimeClient for testing
const createMockRuntimeClient = (): RuntimeClient => {
  const conn = {
    request: () => Promise.resolve({}),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
  };
  return {
    [$conn]: () => conn,
    getConnection: () => ({
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    }),
  } as unknown as RuntimeClient;
};

// Create a minimal DOM environment for testing
// Note: This doesn't fully replicate HTMLElement behavior
function createMockDocument() {
  let idCounter = 0;

  const createElement = (tagName: string) => {
    const attributes = new Map<string, string>();
    const eventListeners = new Map<
      string,
      ((event: MockDomEvent) => void)[]
    >();
    const childNodes: MockDomNode[] = [];

    const element: MockDomNode = {
      tagName: tagName.toUpperCase(),
      textContent: "",
      _id: `mock-${idCounter++}`,
      nodeType: 1, // ELEMENT_NODE
      parentNode: null,
      childNodes,
      get dataset() {
        const dataset: Record<string, string> = {};
        for (const [name, value] of attributes.entries()) {
          if (!name.startsWith("data-")) {
            continue;
          }
          const key = name.slice(5).replace(
            /-([a-z])/g,
            (_, char: string) => char.toUpperCase(),
          );
          dataset[key] = value;
        }
        return dataset;
      },

      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
      getAttribute(name: string) {
        return attributes.get(name) ?? null;
      },
      hasAttribute(name: string) {
        return attributes.has(name);
      },
      removeAttribute(name: string) {
        attributes.delete(name);
      },
      appendChild(child: MockDomNode) {
        // Remove from current position if already a child (handles move)
        const existingIndex = childNodes.indexOf(child);
        if (existingIndex >= 0) {
          childNodes.splice(existingIndex, 1);
        }

        child.parentNode = this;
        childNodes.push(child);
        return child;
      },
      insertBefore(child: MockDomNode, reference: MockDomNode | null) {
        // Remove from current parent if already attached (handles move)
        const existingIndex = childNodes.indexOf(child);
        if (existingIndex >= 0) {
          childNodes.splice(existingIndex, 1);
        }

        child.parentNode = this;
        if (reference === null) {
          childNodes.push(child);
        } else {
          const index = childNodes.indexOf(reference);
          if (index >= 0) {
            childNodes.splice(index, 0, child);
          } else {
            childNodes.push(child);
          }
        }
        return child;
      },
      removeChild(child: MockDomNode) {
        const index = childNodes.indexOf(child);
        if (index >= 0) {
          childNodes.splice(index, 1);
          child.parentNode = null;
        }
        return child;
      },
      addEventListener(
        type: string,
        listener: (event: MockDomEvent) => void,
      ) {
        if (!eventListeners.has(type)) {
          eventListeners.set(type, []);
        }
        eventListeners.get(type)!.push(listener);
      },
      removeEventListener(
        type: string,
        listener: (event: MockDomEvent) => void,
      ) {
        const listeners = eventListeners.get(type);
        if (listeners) {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        }
      },
      dispatchEvent(event: MockDomEvent) {
        const listeners = eventListeners.get(event.type) ?? [];
        listeners.forEach((listener) => listener(event));
      },
    };

    return element;
  };

  const createTextNode = (text: string) => {
    return {
      _id: `text-${idCounter++}`,
      nodeType: 3, // TEXT_NODE
      textContent: text,
      parentNode: null,
    };
  };

  return {
    createElement,
    createTextNode,
  } as unknown as Document;
}

Deno.test("DomApplicator - create elements", async (t) => {
  await t.step("creates an element from create-element op", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    const batch: VDomBatch = {
      batchId: 1,
      ops: [{ op: "create-element", nodeId: 1, tagName: "div" }],
    };

    applicator.applyBatch(batch);

    const node = applicator.getNode(1);
    assertExists(node);
    assertEquals(mockNode(node).tagName, "DIV");
  });

  await t.step("creates a text node from create-text op", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    const batch: VDomBatch = {
      batchId: 1,
      ops: [{ op: "create-text", nodeId: 1, text: "Hello World" }],
    };

    applicator.applyBatch(batch);

    const node = applicator.getNode(1);
    assertExists(node);
    assertEquals(mockNode(node).textContent, "Hello World");
  });

  await t.step("creates multiple elements in one batch", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "div" },
        { op: "create-element", nodeId: 2, tagName: "span" },
        { op: "create-text", nodeId: 3, text: "Hello" },
      ],
    });

    assertExists(applicator.getNode(1));
    assertExists(applicator.getNode(2));
    assertExists(applicator.getNode(3));
    assertEquals(mockNode(applicator.getNode(1)).tagName, "DIV");
    assertEquals(mockNode(applicator.getNode(2)).tagName, "SPAN");
    assertEquals(mockNode(applicator.getNode(3)).textContent, "Hello");
  });

  await t.step("updates text nodes without DOM globals", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "span" },
        { op: "create-text", nodeId: 2, text: "0" },
        { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
      ],
    });

    applicator.applyBatch({
      batchId: 2,
      ops: [{ op: "update-text", nodeId: 2, text: "1" }],
    });

    const textNode = mockNode(applicator.getNode(2));
    assertExists(textNode);
    assertEquals(textNode.textContent, "1");
  });
});

Deno.test("DomApplicator - child operations", async (t) => {
  await t.step("inserts child at end", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "div" },
        { op: "create-element", nodeId: 2, tagName: "span" },
        { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
      ],
    });

    const parent = mockNode(applicator.getNode(1));
    const child = mockNode(applicator.getNode(2));
    assertEquals(parent.childNodes.length, 1);
    assertEquals(parent.childNodes[0], child);
    assertEquals(child.parentNode, parent);
  });

  await t.step("inserts child before another", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "div" },
        { op: "create-element", nodeId: 2, tagName: "span" },
        { op: "create-element", nodeId: 3, tagName: "p" },
        { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
        { op: "insert-child", parentId: 1, childId: 3, beforeId: 2 },
      ],
    });

    const parent = mockNode(applicator.getNode(1));
    assertEquals(parent.childNodes.length, 2);
    assertEquals(parent.childNodes[0].tagName, "P");
    assertEquals(parent.childNodes[1].tagName, "SPAN");
  });

  await t.step(
    "replays insert when child is created later in the batch",
    () => {
      const doc = createMockDocument();
      const applicator = createDomApplicator({
        document: doc,
        runtimeClient: createMockRuntimeClient(),
        onEvent: () => {},
      });

      applicator.applyBatch({
        batchId: 1,
        ops: [
          { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
          { op: "create-element", nodeId: 1, tagName: "div" },
          { op: "create-element", nodeId: 2, tagName: "span" },
        ],
      });

      const parent = applicator.getNode(1) as unknown as {
        childNodes: Array<{ tagName: string }>;
      };
      assertEquals(parent.childNodes.length, 1);
      assertEquals(parent.childNodes[0].tagName, "SPAN");
    },
  );

  await t.step(
    "does not replay stale placement after child moves elsewhere",
    () => {
      const doc = createMockDocument();
      const applicator = createDomApplicator({
        document: doc,
        runtimeClient: createMockRuntimeClient(),
        onEvent: () => {},
      });

      applicator.applyBatch({
        batchId: 1,
        ops: [
          { op: "create-element", nodeId: 1, tagName: "section" },
          { op: "insert-child", parentId: 2, childId: 3, beforeId: null },
          { op: "create-element", nodeId: 3, tagName: "span" },
          { op: "insert-child", parentId: 1, childId: 3, beforeId: null },
          { op: "create-element", nodeId: 2, tagName: "div" },
        ],
      });

      const laterParent = applicator.getNode(1) as unknown as {
        childNodes: Array<{ tagName: string }>;
      };
      const staleParent = applicator.getNode(2) as unknown as {
        childNodes: Array<{ tagName: string }>;
      };
      assertEquals(laterParent.childNodes.map((child) => child.tagName), [
        "SPAN",
      ]);
      assertEquals(staleParent.childNodes, []);
    },
  );

  await t.step(
    "waits for beforeId to attach before replaying placement",
    () => {
      const doc = createMockDocument();
      const applicator = createDomApplicator({
        document: doc,
        runtimeClient: createMockRuntimeClient(),
        onEvent: () => {},
      });

      applicator.applyBatch({
        batchId: 1,
        ops: [
          { op: "create-element", nodeId: 1, tagName: "div" },
          { op: "create-element", nodeId: 4, tagName: "c" },
          { op: "insert-child", parentId: 1, childId: 4, beforeId: null },
          { op: "create-element", nodeId: 2, tagName: "a" },
          { op: "insert-child", parentId: 1, childId: 2, beforeId: 3 },
          { op: "create-element", nodeId: 3, tagName: "b" },
          { op: "insert-child", parentId: 1, childId: 3, beforeId: 4 },
        ],
      });

      const parent = applicator.getNode(1) as unknown as {
        childNodes: Array<{ tagName: string }>;
      };
      assertEquals(parent.childNodes.map((child) => child.tagName), [
        "A",
        "B",
        "C",
      ]);
    },
  );

  await t.step("replays deferred move-child when nodes appear", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "move-child", parentId: 1, childId: 2, beforeId: null },
        { op: "create-element", nodeId: 1, tagName: "div" },
        { op: "create-element", nodeId: 2, tagName: "span" },
      ],
    });

    const parent = applicator.getNode(1) as unknown as {
      childNodes: Array<{ tagName: string }>;
    };
    assertEquals(parent.childNodes.map((child) => child.tagName), ["SPAN"]);
  });

  await t.step(
    "does not replay insert after child is removed before creation",
    () => {
      const doc = createMockDocument();
      const applicator = createDomApplicator({
        document: doc,
        runtimeClient: createMockRuntimeClient(),
        onEvent: () => {},
      });

      applicator.applyBatch({
        batchId: 1,
        ops: [
          { op: "create-element", nodeId: 1, tagName: "div" },
          { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
          { op: "remove-node", nodeId: 2 },
          { op: "create-element", nodeId: 2, tagName: "span" },
        ],
      });

      const parent = applicator.getNode(1) as unknown as {
        childNodes: Array<{ tagName: string }>;
      };
      assertEquals(parent.childNodes, []);
      assertEquals(
        (applicator.getNode(2) as unknown as { tagName: string }).tagName,
        "SPAN",
      );
    },
  );

  await t.step("drops pending inserts that target removed descendants", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "section" },
        { op: "create-element", nodeId: 2, tagName: "div" },
        { op: "create-element", nodeId: 3, tagName: "b" },
        { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
        { op: "insert-child", parentId: 2, childId: 3, beforeId: null },
        { op: "create-element", nodeId: 4, tagName: "a" },
        { op: "insert-child", parentId: 1, childId: 4, beforeId: 3 },
        { op: "remove-node", nodeId: 1 },
        { op: "create-element", nodeId: 5, tagName: "footer" },
      ],
    });

    assertEquals(applicator.getNode(1), undefined);
    assertEquals(applicator.getNode(2), undefined);
    assertEquals(applicator.getNode(3), undefined);
    const pendingChild = applicator.getNode(4) as unknown as {
      parentNode: unknown;
      tagName: string;
    };
    assertEquals(pendingChild.tagName, "A");
    assertEquals(pendingChild.parentNode, null);
  });

  await t.step(
    "appends pending insert when only beforeId anchor is removed",
    () => {
      const doc = createMockDocument();
      const applicator = createDomApplicator({
        document: doc,
        runtimeClient: createMockRuntimeClient(),
        onEvent: () => {},
      });

      applicator.applyBatch({
        batchId: 1,
        ops: [
          { op: "create-element", nodeId: 1, tagName: "section" },
          { op: "create-element", nodeId: 2, tagName: "a" },
          { op: "create-element", nodeId: 3, tagName: "b" },
          { op: "insert-child", parentId: 1, childId: 2, beforeId: 3 },
        ],
      });

      const parent = applicator.getNode(1) as unknown as {
        childNodes: Array<{ tagName: string }>;
      };
      const pendingChild = applicator.getNode(2) as unknown as {
        parentNode: unknown;
        tagName: string;
      };
      assertEquals(parent.childNodes, []);
      assertEquals(pendingChild.parentNode, null);

      applicator.applyBatch({
        batchId: 2,
        ops: [{ op: "remove-node", nodeId: 3 }],
      });

      assertEquals(parent.childNodes.map((child) => child.tagName), ["A"]);
      assertEquals(pendingChild.parentNode, parent);
    },
  );

  await t.step("moves child to new position", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "div" },
        { op: "create-element", nodeId: 2, tagName: "a" },
        { op: "create-element", nodeId: 3, tagName: "b" },
        { op: "create-element", nodeId: 4, tagName: "c" },
        { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
        { op: "insert-child", parentId: 1, childId: 3, beforeId: null },
        { op: "insert-child", parentId: 1, childId: 4, beforeId: null },
      ],
    });

    // Move first child to end
    applicator.applyBatch({
      batchId: 2,
      ops: [{ op: "move-child", parentId: 1, childId: 2, beforeId: null }],
    });

    const parent = mockNode(applicator.getNode(1));
    assertEquals(parent.childNodes.length, 3);
    assertEquals(parent.childNodes[0].tagName, "B");
    assertEquals(parent.childNodes[1].tagName, "C");
    assertEquals(parent.childNodes[2].tagName, "A");
  });

  await t.step("removes a node", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "div" },
        { op: "create-element", nodeId: 2, tagName: "span" },
        { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
      ],
    });

    applicator.applyBatch({
      batchId: 2,
      ops: [{ op: "remove-node", nodeId: 2 }],
    });

    const parent = mockNode(applicator.getNode(1));
    assertEquals(parent.childNodes.length, 0);
    assertEquals(applicator.getNode(2), undefined);
  });

  await t.step("removes listeners from removed descendants", () => {
    const doc = createMockDocument();
    const events: DomEventMessage[] = [];
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: (msg) => events.push(msg),
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "section" },
        { op: "create-element", nodeId: 2, tagName: "button" },
        { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
        { op: "set-event", nodeId: 1, eventType: "click", handlerId: 11 },
        { op: "set-event", nodeId: 2, eventType: "click", handlerId: 22 },
      ],
    });

    const parentNode = applicator.getNode(1) as unknown as {
      dispatchEvent(event: {
        type: string;
        target: unknown;
        isTrusted: boolean;
      }): void;
    };
    const childNode = applicator.getNode(2) as unknown as {
      dispatchEvent(event: {
        type: string;
        target: unknown;
        isTrusted: boolean;
      }): void;
    };

    applicator.applyBatch({
      batchId: 2,
      ops: [{ op: "remove-node", nodeId: 1 }],
    });

    parentNode.dispatchEvent({
      type: "click",
      target: parentNode,
      isTrusted: true,
    });
    childNode.dispatchEvent({
      type: "click",
      target: childNode,
      isTrusted: true,
    });

    assertEquals(events, []);
    assertEquals(applicator.getNode(1), undefined);
    assertEquals(applicator.getNode(2), undefined);
  });
});

Deno.test("DomApplicator - event handling", async (t) => {
  await t.step("sets event listener and dispatches events", () => {
    const doc = createMockDocument();
    const events: DomEventMessage[] = [];
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: (msg) => events.push(msg),
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "button" },
        { op: "set-event", nodeId: 1, eventType: "click", handlerId: 42 },
      ],
    });

    // Simulate a click
    const node = mockNode(applicator.getNode(1));
    node.dispatchEvent({ type: "click", target: node, isTrusted: true });

    assertEquals(events.length, 1);
    assertEquals(events[0].type, "dom-event");
    assertEquals(events[0].handlerId, 42);
    assertEquals(events[0].nodeId, 1);
    assertEquals(events[0].event.type, "click");
    assertEquals(events[0].event.provenance, {
      origin: "dom",
      trusted: true,
    });
  });

  await t.step("serializes data-ui dataset markers with trusted events", () => {
    const doc = createMockDocument();
    const events: DomEventMessage[] = [];
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: (msg) => events.push(msg),
      setProp: (target, key, value) => {
        if (
          key.startsWith("data-") &&
          typeof target === "object" &&
          target !== null &&
          "setAttribute" in target &&
          typeof target.setAttribute === "function"
        ) {
          target.setAttribute(key, String(value));
          return;
        }
        (target as Record<string, unknown>)[key] = value;
      },
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "button" },
        {
          op: "set-attrs",
          nodeId: 1,
          attrs: { "data-ui-action": "SubmitDirectCommand" },
        },
        { op: "set-event", nodeId: 1, eventType: "click", handlerId: 42 },
      ],
    });

    const node = mockNode(applicator.getNode(1));
    node.dispatchEvent({ type: "click", target: node, isTrusted: true });

    assertEquals(events[0].event.target?.dataset, {
      uiAction: "SubmitDirectCommand",
    });
  });

  await t.step("attests nearest trusted UI pattern provenance", () => {
    const doc = createMockDocument();
    const events: DomEventMessage[] = [];
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: (msg) => events.push(msg),
      setProp: (target, key, value) => {
        if (
          key.startsWith("data-") &&
          typeof target === "object" &&
          target !== null &&
          "setAttribute" in target &&
          typeof target.setAttribute === "function"
        ) {
          target.setAttribute(key, String(value));
          return;
        }
        (target as Record<string, unknown>)[key] = value;
      },
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "section" },
        {
          op: "set-attrs",
          nodeId: 1,
          attrs: {
            "data-ui-pattern": "TrustedDirectCommandSurface",
            "data-ui-event-integrity": "TrustedDirectCommandSurface",
          },
        },
        { op: "create-element", nodeId: 2, tagName: "button" },
        {
          op: "set-attrs",
          nodeId: 2,
          attrs: { "data-ui-action": "SubmitDirectCommand" },
        },
        {
          op: "insert-child",
          parentId: 1,
          childId: 2,
          beforeId: null,
        },
        { op: "set-event", nodeId: 2, eventType: "click", handlerId: 42 },
      ],
    });

    const node = mockNode(applicator.getNode(2));
    node.dispatchEvent({ type: "click", target: node, isTrusted: true });

    assertEquals(events[0].event.provenance, {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "TrustedDirectCommandSurface",
        eventIntegrity: ["TrustedDirectCommandSurface"],
        uiContractDataset: {
          uiAction: "SubmitDirectCommand",
        },
      },
    });
  });

  await t.step("removes event listener", () => {
    const doc = createMockDocument();
    const events: DomEventMessage[] = [];
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: (msg) => events.push(msg),
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "button" },
        { op: "set-event", nodeId: 1, eventType: "click", handlerId: 42 },
      ],
    });

    applicator.applyBatch({
      batchId: 2,
      ops: [{ op: "remove-event", nodeId: 1, eventType: "click" }],
    });

    // Simulate a click - should not trigger event
    const node = mockNode(applicator.getNode(1));
    node.dispatchEvent({ type: "click", target: node });

    assertEquals(events.length, 0);
  });

  await t.step("replaces event handler when setting same event type", () => {
    const doc = createMockDocument();
    const events: DomEventMessage[] = [];
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: (msg) => events.push(msg),
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "button" },
        { op: "set-event", nodeId: 1, eventType: "click", handlerId: 1 },
      ],
    });

    applicator.applyBatch({
      batchId: 2,
      ops: [{ op: "set-event", nodeId: 1, eventType: "click", handlerId: 2 }],
    });

    const node = mockNode(applicator.getNode(1));
    node.dispatchEvent({ type: "click", target: node });

    // Should only have one event with the new handler ID
    assertEquals(events.length, 1);
    assertEquals(events[0].handlerId, 2);
  });
});

Deno.test("DomApplicator - cell bindings", async (t) => {
  const cellRef: CellRef = {
    id: "of:test-cell" as CellRef["id"],
    space: "did:key:test-space" as CellRef["space"],
    scope: "space",
    path: ["value"],
    schema: { type: "string" },
  };

  await t.step("does not replace a binding for the same cell ref", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "cf-cell-link" },
        { op: "set-binding", nodeId: 1, propName: "cell", cellRef },
      ],
    });

    const node = mockNode(applicator.getNode(1));
    const firstHandle = node.cell;
    assertExists(firstHandle);

    applicator.applyBatch({
      batchId: 2,
      ops: [{ op: "set-binding", nodeId: 1, propName: "cell", cellRef }],
    });

    assertStrictEquals(node.cell, firstHandle);

    applicator.applyBatch({
      batchId: 3,
      ops: [{
        op: "set-binding",
        nodeId: 1,
        propName: "cell",
        cellRef: { ...cellRef, schema: { type: "number" } },
      }],
    });

    assertNotStrictEquals(node.cell, firstHandle);
  });
});

Deno.test("DomApplicator - batch with rootId", async (t) => {
  await t.step("tracks root node ID", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [{ op: "create-element", nodeId: 5, tagName: "div" }],
      rootId: 5,
    });

    const root = applicator.getRootNode();
    assertExists(root);
    assertEquals(mockNode(root).tagName, "DIV");
  });

  await t.step("updates root when rootId changes", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [{ op: "create-element", nodeId: 1, tagName: "div" }],
      rootId: 1,
    });

    applicator.applyBatch({
      batchId: 2,
      ops: [{ op: "create-element", nodeId: 2, tagName: "span" }],
      rootId: 2,
    });

    const root = applicator.getRootNode();
    assertEquals(mockNode(root).tagName, "SPAN");
  });
});

Deno.test("DomApplicator - mountInto", async (t) => {
  await t.step("mounts root into parent element", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [{ op: "create-element", nodeId: 1, tagName: "div" }],
      rootId: 1,
    });

    const container = doc.createElement("section") as unknown as HTMLElement;
    applicator.mountInto(container, 1);

    assertEquals(mockNode(container).childNodes.length, 1);
    assertEquals(mockNode(container).childNodes[0].tagName, "DIV");
  });
});

Deno.test("DomApplicator - setContainer", async (t) => {
  await t.step("registers container element with CONTAINER_NODE_ID (0)", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    const container = doc.createElement("section") as unknown as HTMLElement;
    applicator.setContainer(container);

    // Verify container is registered with ID 0
    assertEquals(applicator.getNode(0), container);
  });

  await t.step("allows inserting children directly into container", () => {
    const doc = createMockDocument();
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
    });

    const container = doc.createElement("section") as unknown as HTMLElement;
    applicator.setContainer(container);

    // Insert a child directly into the container (node 0)
    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "div" },
        { op: "insert-child", parentId: 0, childId: 1, beforeId: null },
      ],
    });

    assertEquals(mockNode(container).childNodes.length, 1);
    assertEquals(mockNode(container).childNodes[0].tagName, "DIV");
  });
});

Deno.test("DomApplicator - dispose", async (t) => {
  await t.step("cleans up all nodes and listeners", () => {
    const doc = createMockDocument();
    const events: DomEventMessage[] = [];
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: (msg) => events.push(msg),
    });

    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "create-element", nodeId: 1, tagName: "div" },
        { op: "create-element", nodeId: 2, tagName: "button" },
        { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
        { op: "set-event", nodeId: 2, eventType: "click", handlerId: 1 },
      ],
      rootId: 1,
    });

    applicator.dispose();

    assertEquals(applicator.getNode(1), undefined);
    assertEquals(applicator.getNode(2), undefined);
    assertEquals(applicator.getRootNode(), null);
  });
});

Deno.test("DomApplicator - error handling", async (t) => {
  await t.step("continues processing batch after operation error", () => {
    const doc = createMockDocument();
    const errors: Error[] = [];
    const applicator = createDomApplicator({
      document: doc,
      runtimeClient: createMockRuntimeClient(),
      onEvent: () => {},
      onError: (err) => errors.push(err),
    });

    // This should not crash even with invalid operations
    applicator.applyBatch({
      batchId: 1,
      ops: [
        { op: "update-text", nodeId: 999, text: "test" }, // Non-existent node
        { op: "create-element", nodeId: 1, tagName: "div" }, // Valid
      ],
    });

    // Second op should still have worked
    assertExists(applicator.getNode(1));
  });
});

Deno.test("DomApplicator - bindings", async (t) => {
  await t.step(
    "requests a custom element update after assigning a CellHandle",
    async () => {
      const customElementsDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "customElements",
      );
      Object.defineProperty(globalThis, "customElements", {
        configurable: true,
        value: {
          whenDefined: () => Promise.resolve(undefined),
        },
      });

      const doc = createMockDocument();
      const applicator = createDomApplicator({
        document: doc,
        runtimeClient: createMockRuntimeClient(),
        onEvent: () => {},
      });

      applicator.applyBatch({
        batchId: 1,
        ops: [{ op: "create-element", nodeId: 1, tagName: "cf-cfc-label" }],
      });

      const node = mockNode(applicator.getNode(1));
      const requested: PropertyKey[] = [];
      node.localName = "cf-cfc-label";
      node.requestUpdate = (name?: PropertyKey) => {
        if (name !== undefined) {
          requested.push(name);
        }
      };

      try {
        applicator.applyBatch({
          batchId: 2,
          ops: [{
            op: "set-binding",
            nodeId: 1,
            propName: "value",
            cellRef: {
              space: "did:key:test",
              scope: "space",
              id: "of:test",
              path: [],
            },
          }],
        });

        await Promise.resolve();

        assertEquals(constructorName(node.value), "CellHandle");
        assertEquals(requested, ["value"]);
      } finally {
        if (customElementsDescriptor) {
          Object.defineProperty(
            globalThis,
            "customElements",
            customElementsDescriptor,
          );
        } else {
          Reflect.deleteProperty(globalThis, "customElements");
        }
      }
    },
  );
});

// Note: The following tests require a real DOM environment because the applicator
// uses `instanceof HTMLElement` checks. They are documented here for completeness
// but would need to be run in a browser or with jsdom/happy-dom.
//
// Skipped tests:
// - "sets properties" - requires HTMLElement instanceof check
// - "sets style attribute" - requires HTMLElement instanceof check
// - "sets data attributes" - requires HTMLElement instanceof check
// - "removes properties" - requires HTMLElement instanceof check
// - "updates text content" - requires Node.TEXT_NODE constant
// - "sets bidirectional binding" - requires HTMLElement instanceof check
