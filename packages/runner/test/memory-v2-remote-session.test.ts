import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  createStorageAddressResolver,
  MEMORY_STORAGE_PATH,
  toSpaceWebSocketAddress,
  toWebSocketAddress,
  WebSocketTransport,
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

// Site-table v0: runtime-learned host hints. The registry's refusal
// semantics ARE the contract — seed wins, opened spaces never re-point.
describe("StorageManager.registerSpaceHost", () => {
  const spaceSeeded = "did:key:z6Mk-register-seeded" as MemorySpace;
  const spaceLearned = "did:key:z6Mk-register-learned" as MemorySpace;
  const spaceOpened = "did:key:z6Mk-register-opened" as MemorySpace;

  async function makeManager() {
    const signer = await Identity.fromPassphrase("register-space-host");
    return StorageManager.open({
      as: signer,
      memoryHost: new URL("http://host-a.test"),
      spaceHostMap: { [spaceSeeded]: "http://host-seed.test" },
    });
  }

  it("accepts a hint for an untouched space and refuses re-pointing a seeded one", async () => {
    const manager = await makeManager();
    expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test"))
      .toBe(true);
    // Seed wins: same host confirms, different host refuses.
    expect(manager.registerSpaceHost(spaceSeeded, "http://host-seed.test"))
      .toBe(true);
    expect(manager.registerSpaceHost(spaceSeeded, "http://host-evil.test"))
      .toBe(false);
  });

  it("never re-points an opened space, and the hint routes a fresh open", async () => {
    const realWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = RecordingWebSocket;
    RecordingWebSocket.dialed.length = 0;
    try {
      const manager = await makeManager();
      expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test"))
        .toBe(true);
      manager.open(spaceLearned).sync("of:register-probe" as URI)
        .catch(() => {});
      await RecordingWebSocket.whenDialed(1);
      expect(new URL(RecordingWebSocket.dialed[0]).host).toBe("host-b.test");
      // Now that the space is open: same-host hint confirms; a
      // different host refuses rather than silently re-pointing.
      expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test"))
        .toBe(true);
      expect(manager.registerSpaceHost(spaceLearned, "http://host-c.test"))
        .toBe(false);
      // The opened space refusal also applies with no prior hint.
      manager.open(spaceOpened).sync("of:register-probe" as URI)
        .catch(() => {});
      await RecordingWebSocket.whenDialed(2);
      expect(manager.registerSpaceHost(spaceOpened, "http://host-d.test"))
        .toBe(false);
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    }
  });

  it("throws on a malformed host, naming the space", async () => {
    const manager = await makeManager();
    expect(() => manager.registerSpaceHost(spaceLearned, "not a url"))
      .toThrow(`Invalid host for space ${spaceLearned}`);
  });
});

describe("WebSocketTransport failure signalling", () => {
  // A socket the test opens, closes, and errors by hand. Nothing here waits on
  // a real connection or a timer: the transport reaches its close and error
  // handlers because the test dispatches those events synchronously.
  class DrivableWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: DrivableWebSocket[] = [];
    readyState = DrivableWebSocket.CONNECTING;
    constructor(readonly url: string | URL) {
      super();
      DrivableWebSocket.instances.push(this);
    }
    send(_payload: string): void {}
    close(): void {}
  }

  // Install the drivable socket, hand the body a transport and its socket, then
  // always restore the real global. `send()` reaches `open()`, which constructs
  // the socket synchronously, so `socket()` is available before any event.
  function withTransport(
    body: (
      transport: WebSocketTransport,
      socket: () => DrivableWebSocket,
    ) => Promise<void>,
  ): Promise<void> {
    const realWebSocket = globalThis.WebSocket;
    DrivableWebSocket.instances.length = 0;
    (globalThis as { WebSocket: unknown }).WebSocket = DrivableWebSocket;
    const transport = new WebSocketTransport(
      new URL("wss://memory.test/api/storage/memory"),
    );
    return body(transport, () => DrivableWebSocket.instances.at(-1)!)
      .finally(() => {
        (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
      });
  }

  it("rejects the in-flight send and closes cleanly when the socket closes before opening", async () => {
    await withTransport(async (transport, socket) => {
      let closeCalled = false;
      let closeError: Error | undefined;
      transport.setCloseReceiver((error) => {
        closeCalled = true;
        closeError = error;
      });

      const send = transport.send("frame");
      socket().readyState = DrivableWebSocket.CLOSED;
      socket().dispatchEvent(new Event("close"));

      await expect(send).rejects.toThrow(
        "memory websocket transport closed before opening",
      );
      // A close before opening is not an error, so the receiver gets none.
      expect(closeCalled).toBe(true);
      expect(closeError).toBeUndefined();
    });
  });

  it("surfaces the underlying Error of a socket error to the close receiver", async () => {
    await withTransport(async (transport, socket) => {
      let closeError: Error | undefined;
      transport.setCloseReceiver((error) => {
        closeError = error;
      });

      const boom = new Error("connection refused");
      const send = transport.send("frame");
      socket().dispatchEvent(new ErrorEvent("error", { error: boom }));

      await expect(send).rejects.toBeDefined();
      expect(closeError).toBe(boom);
    });
  });

  it("reports a generic transport error when the error event carries no Error", async () => {
    await withTransport(async (transport, socket) => {
      let closeError: Error | undefined;
      transport.setCloseReceiver((error) => {
        closeError = error;
      });

      const send = transport.send("frame");
      socket().dispatchEvent(new Event("error"));

      await expect(send).rejects.toBeDefined();
      expect(closeError).toBeInstanceOf(Error);
      expect(closeError?.message).toContain("memory websocket transport error");
    });
  });
});
