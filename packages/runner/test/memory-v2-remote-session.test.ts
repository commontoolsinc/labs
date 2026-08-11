import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "@commonfabric/memory/v2";
import {
  createStorageAddressResolver,
  MEMORY_STORAGE_PATH,
  RemoteSessionFactory,
  storageAddressForHost,
  toSpaceWebSocketAddress,
  toWebSocketAddress,
  WebSocketTransport,
} from "../src/storage/v2-remote-session.ts";
import { SpaceHostValidationError } from "../src/space-host.ts";
import { StorageManager } from "../src/storage/v2.ts";
import { TEST_HELLO_SESSION_OPEN } from "./memory-v2-test-utils.ts";

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected call to throw");
}

function expectSafeValidationCause(
  error: Error,
  secret: string,
  message: string,
): void {
  expect(error.message).not.toContain(secret);
  expect(error.cause).toBeInstanceOf(SpaceHostValidationError);
  expect((error.cause as Error).message).toBe(message);
  expect((error.cause as Error).message).not.toContain(secret);
}

function urlWithThrowingHref(cause: Error): URL {
  const host = new URL("https://host-b.test/");
  Object.defineProperty(host, "href", {
    get() {
      throw cause;
    },
  });
  return host;
}

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

  it("preserves a WebSocket-only default memory host", () => {
    const resolve = createStorageAddressResolver(
      new URL("wss://host-a.test/some/base/"),
    );
    expect(resolve(spaceA).toString()).toBe(
      `wss://host-a.test${MEMORY_STORAGE_PATH}`,
    );
    expect(toSpaceWebSocketAddress(resolve(spaceA), spaceA).protocol).toBe(
      "wss:",
    );
  });

  it("rejects an unsupported default memory host protocol", () => {
    expect(() => createStorageAddressResolver(new URL("ftp://host-a.test")))
      .toThrow("Unsupported memory host protocol: ftp:");
    expect(() => createStorageAddressResolver(new URL("memory://local")))
      .toThrow("Unsupported memory host protocol: memory:");
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

  it("rejects a host protocol that cannot serve storage and compute", () => {
    expect(() => storageAddressForHost("ftp://host-b.test"))
      .toThrow("Unsupported space host protocol");
    expect(() => storageAddressForHost("wss://host-b.test"))
      .toThrow("Unsupported space host protocol");
    expect(() =>
      createStorageAddressResolver(
        new URL("https://host-a.test"),
        { [spaceB]: "ftp://host-b.test" },
      )
    ).toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
  });

  it("rejects route components beyond the origin", () => {
    for (
      const host of [
        "https://user@host-b.test/",
        "https://host-b.test/api",
        "https://host-b.test/api/..",
        "https://host-b.test/?region=west",
        "https://host-b.test/#primary",
      ]
    ) {
      expect(() => storageAddressForHost(host)).toThrow();
      expect(() =>
        createStorageAddressResolver(
          new URL("https://host-a.test"),
          { [spaceB]: host },
        )
      ).toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
    }
  });

  it("preserves safe validation causes without repeating route secrets", () => {
    const hosts = [
      [
        "https://user:storage-password-sentinel@host-b.test/",
        "storage-password-sentinel",
        "Space host must not include credentials",
      ],
      [
        "https://host-b.test/?token=storage-query-sentinel",
        "storage-query-sentinel",
        "Space host must not include a query",
      ],
      [
        "https://user:storage-parse-password-sentinel@[/",
        "storage-parse-password-sentinel",
        "Invalid space host URL",
      ],
    ] as const;
    for (const [host, secret, message] of hosts) {
      const error = captureError(() =>
        createStorageAddressResolver(
          new URL("https://host-a.test"),
          { [spaceB]: host },
        )
      );
      expectSafeValidationCause(error, secret, message);
    }
  });

  it("propagates non-validation errors unchanged", () => {
    for (
      const cause of [
        new Error("unexpected route read failure"),
        new TypeError("unexpected route read type failure"),
      ]
    ) {
      const host = urlWithThrowingHref(cause) as unknown as string;
      const error = captureError(() =>
        createStorageAddressResolver(
          new URL("https://host-a.test"),
          { [spaceB]: host },
        )
      );
      expect(error).toBe(cause);
    }
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

// Site-table v0: runtime-learned host hints. A default-host connection remains
// provisional until the first configured or accepted route is known.
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

  it("keeps an accepted hint stable and replaces a provisional default route", async () => {
    const realWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = RecordingWebSocket;
    RecordingWebSocket.dialed.length = 0;
    let manager: Awaited<ReturnType<typeof makeManager>> | undefined;
    try {
      manager = await makeManager();
      expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test"))
        .toBe(true);
      expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test/"))
        .toBe(true);
      expect(manager.registerSpaceHost(spaceLearned, "http://host-c.test"))
        .toBe(false);
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
      expect(new URL(RecordingWebSocket.dialed[1]).host).toBe("host-a.test");
      expect(manager.registerSpaceHost(spaceOpened, "http://host-d.test"))
        .toBe(true);
      await RecordingWebSocket.whenDialed(3);
      expect(new URL(RecordingWebSocket.dialed[2]).host).toBe("host-d.test");
      expect(manager.registerSpaceHost(spaceOpened, "http://host-d.test"))
        .toBe(true);
      expect(manager.registerSpaceHost(spaceOpened, "http://host-e.test"))
        .toBe(false);
    } finally {
      await manager?.closeNow();
      (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    }
  });

  it("throws on a malformed host, naming the space", async () => {
    const manager = await makeManager();
    expect(() => manager.registerSpaceHost(spaceLearned, "not a url"))
      .toThrow(`Invalid host for space ${spaceLearned}`);
  });

  it("rejects an unusable first hint without fixing the route", async () => {
    const manager = await makeManager();
    for (
      const host of [
        "mailto:memory@example.test",
        "wss://host-b.test",
        "https://user@host-b.test/",
        "https://host-b.test/api",
        "https://host-b.test/%2e%2e/",
        "https://host-b.test/?region=west",
        "https://host-b.test/#primary",
      ]
    ) {
      expect(() => manager.registerSpaceHost(spaceLearned, host))
        .toThrow(`Invalid host for space ${spaceLearned}`);
    }
    expect(manager.registerSpaceHost(spaceLearned, "https://host-b.test"))
      .toBe(true);
  });

  it("preserves safe live validation causes without repeating route secrets", async () => {
    const manager = await makeManager();
    try {
      for (
        const [host, secret, message] of [
          [
            "https://user:live-password-sentinel@host-b.test/",
            "live-password-sentinel",
            "Space host must not include credentials",
          ],
          [
            "https://host-b.test/?token=live-query-sentinel",
            "live-query-sentinel",
            "Space host must not include a query",
          ],
          [
            "https://user:live-parse-password-sentinel@[/",
            "live-parse-password-sentinel",
            "Invalid space host URL",
          ],
        ] as const
      ) {
        const error = captureError(() =>
          manager.registerSpaceHost(spaceLearned, host)
        );
        expectSafeValidationCause(error, secret, message);
      }
    } finally {
      await manager.closeNow();
    }
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
    readonly sent: string[] = [];
    #sentWaiters: Array<{ count: number; resolve: () => void }> = [];
    constructor(readonly url: string | URL) {
      super();
      DrivableWebSocket.instances.push(this);
    }
    send(payload: string): void {
      this.sent.push(payload);
      this.#sentWaiters = this.#sentWaiters.filter((waiter) => {
        if (this.sent.length >= waiter.count) {
          waiter.resolve();
          return false;
        }
        return true;
      });
    }
    whenSent(count: number): Promise<void> {
      if (this.sent.length >= count) return Promise.resolve();
      return new Promise((resolve) =>
        this.#sentWaiters.push({ count, resolve })
      );
    }
    openConnection(): void {
      this.readyState = DrivableWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }
    receive(payload: string): void {
      this.dispatchEvent(new MessageEvent("message", { data: payload }));
    }
    close(): void {
      this.readyState = DrivableWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
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

  it("cancels a remote session while its websocket is opening", async () => {
    const signer = await Identity.fromPassphrase(
      "cancel-opening-remote-session",
    );
    const space = signer.did();
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");
    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
      );
      const opening = factory.create(
        space,
        signer,
        {},
        controller.signal,
      );

      controller.abort(reason);

      await expect(opening).rejects.toBe(reason);
      expect(socket().readyState).toBe(DrivableWebSocket.CLOSED);
    });
  });

  it("cancels a remote session while its session signature is pending", async () => {
    const identity = await Identity.fromPassphrase(
      "cancel-signing-remote-session",
    );
    const signingStarted = Promise.withResolvers<void>();
    const releaseSigning = Promise.withResolvers<void>();
    const signer: Signer = {
      did: () => identity.did(),
      verifier: identity.verifier,
      async sign(payload) {
        signingStarted.resolve();
        await releaseSigning.promise;
        return await identity.sign(payload);
      },
    };
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");

    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
      );
      const opening = factory.create(
        signer.did(),
        signer,
        {},
        controller.signal,
      );
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      activeSocket.receive(encodeMemoryBoundary({
        type: "hello.ok",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
        sessionOpen: TEST_HELLO_SESSION_OPEN,
      }));
      await signingStarted.promise;

      controller.abort(reason);

      await expect(opening).rejects.toBe(reason);
      expect(activeSocket.readyState).toBe(DrivableWebSocket.CLOSED);
      expect(activeSocket.sent).toHaveLength(1);
      releaseSigning.resolve();
    });
  });

  it("cancels reconnect session signing before closing the old client", async () => {
    const identity = await Identity.fromPassphrase(
      "cancel-reconnect-signing-remote-session",
    );
    const reconnectSigningStarted = Promise.withResolvers<void>();
    const releaseReconnectSigning = Promise.withResolvers<void>();
    let signatures = 0;
    const signer: Signer = {
      did: () => identity.did(),
      verifier: identity.verifier,
      async sign(payload) {
        signatures++;
        if (signatures === 2) {
          reconnectSigningStarted.resolve();
          await releaseReconnectSigning.promise;
        }
        return await identity.sign(payload);
      },
    };
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");

    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
      );
      let opened:
        | Awaited<ReturnType<RemoteSessionFactory["create"]>>
        | undefined;
      try {
        const opening = factory.create(
          signer.did(),
          signer,
          {},
          controller.signal,
        );
        const initialSocket = socket();
        initialSocket.openConnection();
        await initialSocket.whenSent(1);
        initialSocket.receive(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          sessionOpen: TEST_HELLO_SESSION_OPEN,
        }));
        await initialSocket.whenSent(2);
        const initialOpen = decodeMemoryBoundary(initialSocket.sent[1]) as {
          requestId: string;
        };
        initialSocket.receive(encodeMemoryBoundary({
          type: "response",
          requestId: initialOpen.requestId,
          ok: {
            sessionId: "session:cancel-reconnect-signing",
            sessionToken: "token:cancel-reconnect-signing",
            serverSeq: 0,
            sessionOpen: TEST_HELLO_SESSION_OPEN,
          },
        }));
        opened = await opening;

        initialSocket.close();
        const reconnectSocket = socket();
        expect(reconnectSocket).not.toBe(initialSocket);
        reconnectSocket.openConnection();
        await reconnectSocket.whenSent(1);
        reconnectSocket.receive(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          sessionOpen: TEST_HELLO_SESSION_OPEN,
        }));
        await reconnectSigningStarted.promise;

        controller.abort(reason);
        await opened.client.close();

        expect(reconnectSocket.readyState).toBe(DrivableWebSocket.CLOSED);
        expect(reconnectSocket.sent).toHaveLength(1);
        expect(signatures).toBe(2);
      } finally {
        controller.abort(reason);
        releaseReconnectSigning.resolve();
        await opened?.client.close();
      }
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
