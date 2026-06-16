import { assertEquals } from "@std/assert";
import type { CellRef } from "@commonfabric/runtime-client";
import { MockDoc } from "../src/mock-doc.ts";
import { VDomRenderer } from "../src/main/renderer.ts";

class MockConnection {
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  public unmountCalls: number[] = [];
  public acknowledgedBatches: Array<{ mountId: number; batchId: number }> = [];
  public sentEvents: Array<{
    mountId: number;
    handlerId: number;
    event: unknown;
    nodeId: number;
  }> = [];

  on(event: string, callback: (payload: unknown) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  off(event: string, callback: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  mountVDom(
    _mountId: number,
    _cellRef: CellRef,
  ): Promise<{ rootId: number }> {
    return Promise.resolve({ rootId: 0 });
  }

  unmountVDom(mountId: number): Promise<void> {
    this.unmountCalls.push(mountId);
    return Promise.resolve();
  }

  sendVDomEvent(): void {
    const [mountId, handlerId, event, nodeId] = arguments as unknown as [
      number,
      number,
      unknown,
      number,
    ];
    this.sentEvents.push({ mountId, handlerId, event, nodeId });
  }

  ackVDomBatch(mountId: number, batchId: number): void {
    this.acknowledgedBatches.push({ mountId, batchId });
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

Deno.test("VDomRenderer - does not remove container when rootId is sentinel 0", async () => {
  const removedNodes: unknown[] = [];
  const parentNode = {
    removeChild(node: unknown) {
      removedNodes.push(node);
    },
  };
  const container = { parentNode };
  const connection = new MockConnection();

  const renderer = new VDomRenderer({
    runtimeClient: {} as any,
    connection: connection as any,
    document: {
      createElement: (tagName: string) => ({ tagName }),
      createTextNode: (text: string) => ({ text }),
    } as unknown as Document,
  });

  const cellRef = {
    space: "did:key:test",
    id: "cell-id",
    path: [],
    type: "application/json",
  } as unknown as CellRef;

  await renderer.render(container as unknown as HTMLElement, cellRef);
  await renderer.stopRendering();

  assertEquals(connection.unmountCalls.length, 1);
  assertEquals(removedNodes.includes(container), false);
});

Deno.test("VDomRenderer - forwards trusted event provenance through delivery", async () => {
  const connection = new MockConnection();
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const renderer = new VDomRenderer({
    runtimeClient: {} as any,
    connection: connection as any,
    document: mock.document,
  });

  const cellRef = {
    space: "did:key:test",
    id: "cell-id",
    path: [],
    type: "application/json",
  } as unknown as CellRef;

  const container = mock.document.getElementById("root")!;
  await renderer.render(container as unknown as HTMLElement, cellRef);
  const mountId = renderer.getMountId();
  if (mountId === null) {
    throw new Error("expected renderer to have an active mount");
  }

  renderer.getApplicator().applyBatch({
    batchId: 1,
    ops: [
      { op: "create-element", nodeId: 1, tagName: "button" },
      { op: "set-event", nodeId: 1, eventType: "click", handlerId: 42 },
    ],
  });

  const button = renderer.getApplicator().getNode(1) as any;
  button.dispatchEvent({
    type: "click",
    target: button,
    isTrusted: true,
  });

  assertEquals(connection.sentEvents.length, 1);
  assertEquals(connection.sentEvents[0], {
    mountId,
    handlerId: 42,
    nodeId: 1,
    event: {
      type: "click",
      target: {
        name: "button",
      },
      provenance: { origin: "dom", trusted: true },
    },
  });

  await renderer.dispose();
});

Deno.test("VDomRenderer - acknowledges applied batches", async () => {
  const connection = new MockConnection();
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const renderer = new VDomRenderer({
    runtimeClient: {} as any,
    connection: connection as any,
    document: mock.document,
  });

  const cellRef = {
    space: "did:key:test",
    id: "cell-id",
    path: [],
    type: "application/json",
  } as unknown as CellRef;

  const container = mock.document.getElementById("root")!;
  await renderer.render(container as unknown as HTMLElement, cellRef);
  const mountId = renderer.getMountId();
  if (mountId === null) {
    throw new Error("expected renderer to have an active mount");
  }

  connection.emit("vdombatch", {
    type: "vdom:batch",
    batchId: 7,
    mountId,
    ops: [{ op: "create-element", nodeId: 1, tagName: "button" }],
    rootId: 1,
  });

  assertEquals(connection.acknowledgedBatches, [{ mountId, batchId: 7 }]);

  await renderer.dispose();
});
