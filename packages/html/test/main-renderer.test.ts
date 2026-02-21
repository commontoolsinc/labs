import { assertEquals } from "@std/assert";
import type { CellRef } from "@commontools/runtime-client";
import { VDomRenderer } from "../src/main/renderer.ts";

class MockConnection {
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  public unmountCalls: number[] = [];

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
    // no-op for this test
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
    document: ({
      createElement: (tagName: string) => ({ tagName }),
      createTextNode: (text: string) => ({ text }),
    } as unknown as Document),
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
