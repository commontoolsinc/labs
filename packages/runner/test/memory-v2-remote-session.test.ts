import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  createStorageAddressResolver,
  MEMORY_STORAGE_PATH,
  toSpaceWebSocketAddress,
  toWebSocketAddress,
} from "../src/storage/v2-remote-session.ts";
import { StorageManager } from "../src/storage/v2.ts";

describe("memory v2 remote session websocket address", () => {
  it("upgrades http and https urls to websocket protocols", () => {
    expect(
      toWebSocketAddress(new URL("http://example.test/storage")).toString(),
    ).toBe("ws://example.test/storage");
    expect(
      toWebSocketAddress(new URL("https://example.test/storage")).toString(),
    ).toBe("wss://example.test/storage");
  });

  it("preserves existing websocket protocols", () => {
    expect(
      toWebSocketAddress(new URL("ws://example.test/storage")).toString(),
    ).toBe("ws://example.test/storage");
    expect(
      toWebSocketAddress(new URL("wss://example.test/storage")).toString(),
    ).toBe("wss://example.test/storage");
  });

  it("adds the memory space to the websocket query", () => {
    expect(
      toSpaceWebSocketAddress(
        new URL("https://example.test/api/storage/memory?trace=1"),
        "did:key:z6Mk-storage-space",
      ).toString(),
    ).toBe(
      "wss://example.test/api/storage/memory?trace=1&space=did%3Akey%3Az6Mk-storage-space",
    );
  });
});

describe("per-space storage address resolution", () => {
  const spaceA = "did:key:z6Mk-space-a" as MemorySpace;
  const spaceB = "did:key:z6Mk-space-b" as MemorySpace;

  it("resolves every space to the default host without a map", () => {
    const resolve = createStorageAddressResolver(
      new URL("https://host-a.test"),
    );
    expect(resolve(spaceA).toString()).toBe(
      `https://host-a.test${MEMORY_STORAGE_PATH}`,
    );
    expect(resolve(spaceB).toString()).toBe(
      `https://host-a.test${MEMORY_STORAGE_PATH}`,
    );
  });

  it("resolves a mapped space to its host and others to the default", () => {
    const resolve = createStorageAddressResolver(
      new URL("https://host-a.test"),
      { [spaceB]: "https://host-b.test:8000" },
    );
    expect(resolve(spaceA).toString()).toBe(
      `https://host-a.test${MEMORY_STORAGE_PATH}`,
    );
    expect(resolve(spaceB).toString()).toBe(
      `https://host-b.test:8000${MEMORY_STORAGE_PATH}`,
    );
  });

  it("yields distinct websocket targets for spaces on distinct hosts", () => {
    const resolve = createStorageAddressResolver(
      new URL("http://host-a.test"),
      { [spaceB]: "http://host-b.test" },
    );
    const wsA = toSpaceWebSocketAddress(resolve(spaceA), spaceA);
    const wsB = toSpaceWebSocketAddress(resolve(spaceB), spaceB);
    expect(wsA.host).not.toBe(wsB.host);
    expect(wsA.toString()).toBe(
      `ws://host-a.test${MEMORY_STORAGE_PATH}?space=${
        encodeURIComponent(spaceA)
      }`,
    );
    expect(wsB.toString()).toBe(
      `ws://host-b.test${MEMORY_STORAGE_PATH}?space=${
        encodeURIComponent(spaceB)
      }`,
    );
  });

  it("ignores any path on the host base URL (host selection only)", () => {
    const resolve = createStorageAddressResolver(
      new URL("https://host-a.test/some/base/"),
    );
    expect(resolve(spaceA).toString()).toBe(
      `https://host-a.test${MEMORY_STORAGE_PATH}`,
    );
  });

  it("rejects a malformed spaceHostMap entry eagerly, naming the space", () => {
    expect(() =>
      createStorageAddressResolver(
        new URL("https://host-a.test"),
        { [spaceB]: "not a url" },
      )
    ).toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
  });
});

/**
 * Stand-in WebSocket that records every dialed URL and never connects.
 * Session creation stalls on the silent socket, which is fine: the test
 * only asserts which hosts were dialed.
 */
class RecordingWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static dialed: string[] = [];
  static #waiters: Array<{ count: number; resolve: () => void }> = [];
  readyState = RecordingWebSocket.CONNECTING;
  constructor(url: string | URL) {
    super();
    RecordingWebSocket.dialed.push(url.toString());
    RecordingWebSocket.#waiters = RecordingWebSocket.#waiters.filter(
      (waiter) => {
        if (RecordingWebSocket.dialed.length >= waiter.count) {
          waiter.resolve();
          return false;
        }
        return true;
      },
    );
  }
  /** Resolves once `count` sockets have been dialed — no polling. */
  static whenDialed(count: number): Promise<void> {
    if (RecordingWebSocket.dialed.length >= count) return Promise.resolve();
    return new Promise((resolve) =>
      RecordingWebSocket.#waiters.push({ count, resolve })
    );
  }
  send(_payload: string): void {}
  close(): void {}
}

describe("StorageManager per-space host wiring", () => {
  // The pending session promises hold no resources, but their microtask
  // chains outlive the test body; opt out of the op sanitizer for that.
  it("dials a mapped space on its host and others on the default", {
    sanitizeOps: false,
    sanitizeResources: false,
  }, async () => {
    const realWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = RecordingWebSocket;
    try {
      const signer = await Identity.fromPassphrase("per-space-host-wiring");
      const spaceA = signer.did();
      const spaceB = "did:key:z6Mk-other-space" as MemorySpace;
      const manager = StorageManager.open({
        as: signer,
        memoryHost: new URL("http://host-a.test"),
        spaceHostMap: { [spaceB]: "http://host-b.test" },
      });
      manager.open(spaceA).sync("of:wiring-probe" as URI).catch(() => {});
      manager.open(spaceB).sync("of:wiring-probe" as URI).catch(() => {});
      await RecordingWebSocket.whenDialed(2);
      const hosts = RecordingWebSocket.dialed.map((url) => new URL(url).host)
        .sort();
      expect(hosts).toEqual(["host-a.test", "host-b.test"]);
      for (const url of RecordingWebSocket.dialed) {
        expect(new URL(url).pathname).toBe(MEMORY_STORAGE_PATH);
      }
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    }
  });
});
