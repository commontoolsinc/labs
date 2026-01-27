/**
 * Tests for the main-thread DOM applicator.
 *
 * Note: Some tests are skipped because they require a real DOM environment
 * (HTMLElement instanceof checks). These would need to be run in a browser
 * or with a DOM library like jsdom/happy-dom.
 */

import { assertEquals, assertExists } from "@std/assert";
import { createDomApplicator } from "./applicator.ts";
import type { VDomBatch } from "../vdom-worker/operations.ts";
import type { DomEventMessage } from "../vdom-worker/events.ts";

// Mock RuntimeClient for testing
const createMockRuntimeClient = () => {
  return {
    getConnection: () => ({
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    }),
  } as any;
};

// Create a minimal DOM environment for testing
// Note: This doesn't fully replicate HTMLElement behavior
function createMockDocument() {
  let idCounter = 0;

  const createElement = (tagName: string) => {
    const attributes = new Map<string, string>();
    const eventListeners = new Map<string, ((event: unknown) => void)[]>();
    const childNodes: any[] = [];

    const element: Record<string, any> = {
      tagName: tagName.toUpperCase(),
      _id: `mock-${idCounter++}`,
      nodeType: 1, // ELEMENT_NODE
      parentNode: null,
      childNodes,

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
      appendChild(child: any) {
        // Remove from current position if already a child (handles move)
        const existingIndex = childNodes.indexOf(child);
        if (existingIndex >= 0) {
          childNodes.splice(existingIndex, 1);
        }

        child.parentNode = this;
        childNodes.push(child);
        return child;
      },
      insertBefore(child: any, reference: any) {
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
      removeChild(child: any) {
        const index = childNodes.indexOf(child);
        if (index >= 0) {
          childNodes.splice(index, 1);
          child.parentNode = null;
        }
        return child;
      },
      addEventListener(type: string, listener: (event: unknown) => void) {
        if (!eventListeners.has(type)) {
          eventListeners.set(type, []);
        }
        eventListeners.get(type)!.push(listener);
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        const listeners = eventListeners.get(type);
        if (listeners) {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        }
      },
      dispatchEvent(event: any) {
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
    assertEquals((node as any).tagName, "DIV");
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
    assertEquals((node as any).textContent, "Hello World");
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
    assertEquals((applicator.getNode(1) as any).tagName, "DIV");
    assertEquals((applicator.getNode(2) as any).tagName, "SPAN");
    assertEquals((applicator.getNode(3) as any).textContent, "Hello");
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

    const parent = applicator.getNode(1) as any;
    const child = applicator.getNode(2) as any;
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

    const parent = applicator.getNode(1) as any;
    assertEquals(parent.childNodes.length, 2);
    assertEquals(parent.childNodes[0].tagName, "P");
    assertEquals(parent.childNodes[1].tagName, "SPAN");
  });

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

    const parent = applicator.getNode(1) as any;
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

    const parent = applicator.getNode(1) as any;
    assertEquals(parent.childNodes.length, 0);
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
    const node = applicator.getNode(1) as any;
    node.dispatchEvent({ type: "click", target: node });

    assertEquals(events.length, 1);
    assertEquals(events[0].type, "dom-event");
    assertEquals(events[0].handlerId, 42);
    assertEquals(events[0].nodeId, 1);
    assertEquals(events[0].event.type, "click");
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
    const node = applicator.getNode(1) as any;
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

    const node = applicator.getNode(1) as any;
    node.dispatchEvent({ type: "click", target: node });

    // Should only have one event with the new handler ID
    assertEquals(events.length, 1);
    assertEquals(events[0].handlerId, 2);
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
    assertEquals((root as any).tagName, "DIV");
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
    assertEquals((root as any).tagName, "SPAN");
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

    assertEquals((container as any).childNodes.length, 1);
    assertEquals((container as any).childNodes[0].tagName, "DIV");
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
