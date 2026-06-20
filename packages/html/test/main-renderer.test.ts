import { assertEquals } from "@std/assert";
import {
  $conn,
  CellHandle,
  type CellRef,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { MockDoc } from "../src/mock-doc.ts";
import { VDomRenderer } from "../src/main/renderer.ts";
import { getActiveRenders, render } from "../src/render.ts";

class MockConnection {
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private lifetime = new AbortController();
  public unmountCalls: number[] = [];
  public acknowledgedBatches: Array<{ mountId: number; batchId: number }> = [];
  public sentEvents: Array<{
    mountId: number;
    handlerId: number;
    event: unknown;
    nodeId: number;
  }> = [];

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** Dispose the connection, as a logout/runtime-swap would. */
  abort(): void {
    this.lifetime.abort();
  }

  onDispose(teardown: () => void): () => void {
    if (this.lifetime.signal.aborted) {
      teardown();
      return () => {};
    }
    this.lifetime.signal.addEventListener("abort", teardown, { once: true });
    return () => this.lifetime.signal.removeEventListener("abort", teardown);
  }

  // The renderer obtains VDOM capability only through attachVDom; the session
  // delegates to the mock's recording methods below.
  attachVDom(onDispose: () => void) {
    const unregister = this.onDispose(onDispose);
    return {
      signal: this.signal,
      mount: (mountId: number, cellRef: CellRef) =>
        this.mountVDom(mountId, cellRef),
      unmount: (mountId: number) => this.unmountVDom(mountId),
      sendEvent: (
        mountId: number,
        handlerId: number,
        event: unknown,
        nodeId: number,
      ) => this.sendVDomEvent(mountId, handlerId, event, nodeId),
      ackBatch: (mountId: number, batchId: number) =>
        this.ackVDomBatch(mountId, batchId),
      onBatch: (handler: (payload: unknown) => void) =>
        this.on("vdombatch", handler),
      offBatch: (handler: (payload: unknown) => void) =>
        this.off("vdombatch", handler),
      detach: unregister,
    };
  }

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

  sendVDomEvent(
    mountId: number,
    handlerId: number,
    event: unknown,
    nodeId: number,
  ): void {
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

Deno.test("VDomRenderer - constructs without throwing against an already-disposed connection", async () => {
  const connection = new MockConnection();
  // Dispose before the renderer attaches: attachVDom runs the teardown
  // synchronously during construction, while `session` is still unassigned.
  connection.abort();

  const renderer = new VDomRenderer({
    runtimeClient: {} as any,
    connection: connection as any,
    document: {
      createElement: (tagName: string) => ({ tagName }),
      createTextNode: (text: string) => ({ text }),
    } as unknown as Document,
  });

  // The renderer is torn down, not half-built: no active mount, and the batch
  // subscription was never registered.
  assertEquals(renderer.getMountId(), null);

  // A torn-down renderer refuses to mount rather than proceeding half-built.
  const cellRef = {
    space: "did:key:test",
    id: "cell-id",
    path: [],
    type: "application/json",
  } as unknown as CellRef;
  const cancel = await renderer.render({} as unknown as HTMLElement, cellRef);
  assertEquals(renderer.getMountId(), null);
  assertEquals(connection.unmountCalls.length, 0);
  await cancel();
});

function workerCellHandle(
  connection: MockConnection,
  id: string,
): CellHandle<unknown> {
  const worker = { [$conn]: () => connection } as unknown as RuntimeClient;
  const cellRef = {
    space: "did:key:test",
    id,
    path: [],
    scope: "space",
    type: "application/json",
  } as unknown as CellRef;
  return new CellHandle(worker, cellRef);
}

Deno.test("render() drives worker rendering and tears down via the connection", async () => {
  const connection = new MockConnection();
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const container = mock.document.getElementById("root")!;
  const cellHandle = workerCellHandle(connection, "of:render-cell");

  const cancel = render(
    container as unknown as HTMLElement,
    cellHandle as CellHandle<any>,
    { document: mock.document },
  );

  // Let the async mount settle so the cancel closure is wired up and the
  // render is registered.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(
    getActiveRenders().has(container as unknown as HTMLElement),
    true,
  );

  cancel();
  // Cancelling drops the registry entry and unmounts worker-side.
  assertEquals(
    getActiveRenders().has(container as unknown as HTMLElement),
    false,
  );
  assertEquals(connection.unmountCalls.length, 1);
  // Let the deferred renderer.dispose() settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

Deno.test("render() reports a mount failure through onError while alive", async () => {
  const connection = new MockConnection();
  // The worker-side mount rejects; render() surfaces it through onError since
  // the connection is neither cancelled nor disposed.
  connection.mountVDom = () => Promise.reject(new Error("mount failed"));
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const container = mock.document.getElementById("root")!;
  const cellHandle = workerCellHandle(connection, "of:render-cell-fail");

  const errors: Error[] = [];
  const cancel = render(
    container as unknown as HTMLElement,
    cellHandle as CellHandle<any>,
    { document: mock.document, onError: (error) => errors.push(error) },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(errors.length, 1);
  assertEquals(errors[0].message, "mount failed");

  cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
