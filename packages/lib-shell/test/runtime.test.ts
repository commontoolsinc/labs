import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { createSession, Identity } from "@commonfabric/identity";
import type { DID } from "@commonfabric/identity";
import {
  createRuntimeClientOptions,
  defaultRenderConfidentialityCeiling,
  RuntimeInternals,
} from "@commonfabric/lib-shell";
import {
  EventEmitter,
  type RuntimeTransport,
  TransportNotificationType,
} from "@commonfabric/runtime-client";

type MockRuntimeClientEvents = {
  console: [unknown];
  navigaterequest: [{ cell: { id(): string; space(): DID } }];
  error: [unknown];
  telemetry: [unknown];
};

class MockRuntimeClient {
  readonly signal: AbortSignal = new AbortController().signal;
  idleCalls = 0;
  syncedCalls = 0;
  slugByPieceId = new Map<string, string | undefined>();
  #handlers = new Map<
    keyof MockRuntimeClientEvents,
    Array<(...args: unknown[]) => void>
  >();

  on<K extends keyof MockRuntimeClientEvents>(
    event: K,
    handler: (...args: MockRuntimeClientEvents[K]) => void,
  ): void {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.#handlers.set(event, handlers);
  }

  emit<K extends keyof MockRuntimeClientEvents>(
    event: K,
    ...args: MockRuntimeClientEvents[K]
  ): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  idle(): Promise<void> {
    this.idleCalls += 1;
    return Promise.resolve();
  }

  synced(): Promise<void> {
    this.syncedCalls += 1;
    return Promise.resolve();
  }

  resolvedSpaceNames: string[] = [];

  resolveSpaceName(name: string): Promise<DID> {
    this.resolvedSpaceNames.push(name);
    return Promise.resolve(`did:key:z6Mk-${name}` as DID);
  }

  getPieceSlug(pieceId: string): Promise<string | undefined> {
    return Promise.resolve(this.slugByPieceId.get(pieceId));
  }

  /** Records the (pieceId, space) argument order source reads arrive in. */
  pieceSourceCalls: Array<{ pieceId: string; space: DID }> = [];

  getPieceSource(pieceId: string, space: DID): Promise<{ pieceId: string }> {
    this.pieceSourceCalls.push({ pieceId, space });
    return Promise.resolve({ pieceId });
  }

  /** Records which space each root-pattern request targeted. */
  spaceRootCalls: DID[] = [];

  getSpaceRootPattern(space: DID): Promise<never> {
    this.spaceRootCalls.push(space);
    return Promise.reject(new Error("no root pattern in mock"));
  }

  /** Records every (pieceId, runIt, space) so tests can assert which calls
   * START the piece (CT-1623: name listings must not start every piece) and
   * which space each call targets. */
  getPieceCalls: Array<
    { pieceId: string; runIt: boolean | undefined; space: DID }
  > = [];

  getPiece(
    pieceId: string,
    space: DID,
    runIt?: boolean,
  ): Promise<{ id: () => string }> {
    this.getPieceCalls.push({ pieceId, runIt, space });
    return Promise.resolve({ id: () => pieceId });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type NavigationDetail = {
  spaceDid: DID;
  pieceId: string;
};

describe("RuntimeInternals", () => {
  describe("getSpaceRootPattern", () => {
    it("caches a successful root-pattern lookup", async () => {
      const client = new MockRuntimeClient();
      const rootPattern = { id: "root-pattern" };
      client.getSpaceRootPattern = (space: DID) => {
        client.spaceRootCalls.push(space);
        return Promise.resolve(rootPattern as never);
      };
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-root-cache" as DID;

      try {
        await expect(runtime.getSpaceRootPattern(space)).resolves.toBe(
          rootPattern,
        );
        await expect(runtime.getSpaceRootPattern(space)).resolves.toBe(
          rootPattern,
        );
        expect(client.spaceRootCalls).toEqual([space]);
      } finally {
        await runtime.dispose();
      }
    });

    it("starts the root for a caller that needs it running, after one that did not", async () => {
      const client = new MockRuntimeClient();
      const starts: Array<boolean | undefined> = [];
      client.getSpaceRootPattern = (
        space: DID,
        options?: { start?: boolean },
      ) => {
        client.spaceRootCalls.push(space);
        starts.push(options?.start);
        return Promise.resolve({ id: `root-${options?.start}` } as never);
      };
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-root-start" as DID;

      try {
        // A root resolved without starting cannot answer a caller that
        // renders it, so the cache must not hand the unstarted one back.
        await runtime.getSpaceRootPattern(space, { start: false });
        await runtime.getSpaceRootPattern(space);
        expect(starts).toEqual([false, true]);

        // The reverse direction shares: a started root already answers a
        // caller that only reads its exports.
        await runtime.getSpaceRootPattern(space, { start: false });
        expect(starts).toEqual([false, true]);
      } finally {
        await runtime.dispose();
      }
    });

    it("caches a recreated root as started", async () => {
      const client = new MockRuntimeClient();
      const recreated = { id: "recreated-root" };
      const starts: Array<boolean | undefined> = [];
      client.getSpaceRootPattern = (
        space: DID,
        options?: { start?: boolean },
      ) => {
        client.spaceRootCalls.push(space);
        starts.push(options?.start);
        return Promise.resolve({ id: "fetched-root" } as never);
      };
      (client as unknown as {
        recreateSpaceRootPattern: (space: DID) => Promise<unknown>;
      }).recreateSpaceRootPattern = () => Promise.resolve(recreated);
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-root-recreate" as DID;

      try {
        await runtime.getSpaceRootPattern(space, { start: false });
        expect(starts).toEqual([false]);

        // Recreating replaces whatever was cached, and what it caches IS
        // started — so neither kind of caller refetches afterwards.
        await expect(runtime.recreateSpaceRootPattern(space)).resolves.toBe(
          recreated,
        );
        await expect(runtime.getSpaceRootPattern(space)).resolves.toBe(
          recreated,
        );
        await expect(runtime.getSpaceRootPattern(space, { start: false }))
          .resolves.toBe(recreated);
        expect(starts).toEqual([false]);
      } finally {
        await runtime.dispose();
      }
    });

    it("retries a root-pattern lookup after rejection", async () => {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-root-retry" as DID;

      try {
        await expect(runtime.getSpaceRootPattern(space)).rejects.toThrow(
          "no root pattern in mock",
        );
        await expect(runtime.getSpaceRootPattern(space)).rejects.toThrow(
          "no root pattern in mock",
        );
        expect(client.spaceRootCalls).toEqual([space, space]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  it("reads a piece's source state through the client", async () => {
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);
    const space = "did:key:z6Mk-source-space" as DID;
    try {
      const source = await runtime.getPieceSource(space, "of:fid1:piece");

      expect(source).toEqual({ pieceId: "of:fid1:piece" });
      // The shell method takes (space, pieceId); the client takes them the
      // other way round, so the order is worth pinning.
      expect(client.pieceSourceCalls).toEqual([{
        pieceId: "of:fid1:piece",
        space,
      }]);
    } finally {
      await runtime.dispose();
    }
  });

  it("resolves named spaces through the worker client", async () => {
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);
    try {
      await expect(runtime.resolveSpaceName("notebook")).resolves.toBe(
        "did:key:z6Mk-notebook",
      );
      expect(client.resolvedSpaceNames).toEqual(["notebook"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("exposes piece slug metadata", async () => {
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    client.slugByPieceId.set("piece-789", "demo");
    const runtime = new RuntimeInternals(client as any);

    try {
      await expect(runtime.getSlug(spaceDid, "piece-789")).resolves.toBe(
        "demo",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("guards removePiece after dispose", async () => {
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);

    await runtime.dispose();

    await expect(runtime.removePiece(spaceDid, "piece-789")).rejects.toThrow(
      "RuntimeInternals disposed.",
    );
  });

  it("uses the default navigation event when no navigation callback is injected", async () => {
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav-current" as DID;
    const client = new MockRuntimeClient();
    let registryWrites = 0;
    client.getSpaceRootPattern = (space: DID) => {
      client.spaceRootCalls.push(space);
      return Promise.resolve({
        cell: () => ({
          key: () => ({
            send: () => {
              registryWrites += 1;
              return Promise.resolve();
            },
          }),
          sync: () => Promise.resolve(),
        }),
      } as never);
    };
    const runtime = new RuntimeInternals(client as any);

    let navigation: NavigationDetail | undefined;
    const navigationReceived = deferred<NavigationDetail>();
    const onNavigate = (event: Event) => {
      navigation = (event as CustomEvent<typeof navigation>).detail;
      navigationReceived.resolve(navigation!);
    };
    globalThis.addEventListener("cf-navigate", onNavigate);

    try {
      client.emit("navigaterequest", {
        cell: {
          id: () => "piece-123",
          space: () => spaceDid,
        },
      });

      await navigationReceived.promise;
      expect(client.idleCalls).toBe(1);
      expect(client.syncedCalls).toBe(1);
      expect(navigation).toEqual({
        spaceDid,
        pieceId: "piece-123",
      });
      expect(client.spaceRootCalls).toEqual([]);
      expect(registryWrites).toBe(0);
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
      await runtime.dispose();
    }
  });

  it("uses an injected navigation callback", async () => {
    const nextSpace = "did:key:z6Mk-lib-shell-runtime-next" as DID;
    const client = new MockRuntimeClient();
    const navigationReceived = deferred<NavigationDetail>();
    const runtime = new RuntimeInternals(
      client as any,
      {
        navigate: (navigation: unknown) => {
          navigationReceived.resolve(navigation as NavigationDetail);
        },
      },
    );

    try {
      client.emit("navigaterequest", {
        cell: {
          id: () => "piece-456",
          space: () => nextSpace,
        },
      });

      await expect(navigationReceived.promise).resolves.toEqual({
        spaceDid: nextSpace,
        pieceId: "piece-456",
      });
      expect(client.idleCalls).toBe(1);
      expect(client.syncedCalls).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("logs a navigation-convergence failure without escaping as unhandled", async () => {
    const space = "did:key:z6Mk-lib-shell-nav-fail" as DID;
    const client = new MockRuntimeClient();
    client.synced = () => Promise.reject(new Error("convergence failed"));

    let navigated = false;
    const runtime = new RuntimeInternals(client as any, {
      navigate: () => {
        navigated = true;
      },
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      client.emit("navigaterequest", {
        cell: { id: () => "piece-fail", space: () => space },
      });
      // Let the fire-and-forget handler settle. An unhandled rejection here
      // would fail the test via Deno's sanitizer.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
      await runtime.dispose();
    }

    expect(navigated).toBe(false);
    expect(errors.length).toBe(1);
  });

  it("abandons navigation convergence silently when disposed mid-flight", async () => {
    const space = "did:key:z6Mk-lib-shell-nav-dispose" as DID;
    const client = new MockRuntimeClient();
    let rejectSynced!: (error: unknown) => void;
    const syncedGate = new Promise<void>((_, reject) => {
      rejectSynced = reject;
    });
    client.synced = () => syncedGate;

    let navigated = false;
    const runtime = new RuntimeInternals(client as any, {
      navigate: () => {
        navigated = true;
      },
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      client.emit("navigaterequest", {
        cell: { id: () => "piece-dispose", space: () => space },
      });
      // The handler is now parked on synced(); dispose, then cancel it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runtime.dispose();
      rejectSynced(new DOMException("aborted", "AbortError"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
    }

    expect(navigated).toBe(false);
    expect(errors.length).toBe(0);
  });

  it("defaults worker runtime options to shell-compatible CFC policy and principal trust", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-runtime-options",
    });

    const experimental = {
      modernCellRep: true,
    };
    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      experimental,
    });

    expect(options.cfcEnforcementMode).toBe("enforce-strict");
    // Epic H2: shell hosts run the flow-label dial at "persist" by default —
    // derived label components are written on every value write, activating
    // inv-9. H1 shipped "observe" (measurement); H2 flips to "persist" now that
    // re-derivation is idempotent (SC-11).
    expect(options.cfcFlowLabels).toBe("persist");
    expect(options.trustSnapshot).toEqual({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    });
    expect(options.spaceDid).toBe(session.space);
    expect(options.spaceName).toBe(session.spaceName);
    expect(options.experimental).toBe(experimental);
    // Epic H3a/H3b: the render ceiling is on by default — display sinks gate
    // against the §8.10.6 profile and author declassification is denied.
    expect(options.renderDeclassificationPolicy).toBe("deny");
    expect(options.renderConfidentialityCeiling).toEqual(
      defaultRenderConfidentialityCeiling(session.as.did()),
    );
  });

  it("populates the §8.10.6 render ceiling when cfcRenderCeiling is on", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-render-ceiling",
    });

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      cfcRenderCeiling: true,
    });

    // Author-supplied render-boundary declassification is denied under the
    // ceiling posture (audit S15) — a pattern cannot release a secret upward
    // through a render boundary.
    expect(options.renderDeclassificationPolicy).toBe("deny");
    expect(options.renderConfidentialityCeiling).toEqual(
      defaultRenderConfidentialityCeiling(session.as.did()),
    );
    // The profile names the acting user's audience through the §15.2
    // principal atom objects (User/PersonalSpace, resolved by the H3b render
    // resolver) plus the legacy DID-string form — every entry names exactly
    // this audience, admissible by construction (§8.10.6).
    expect(options.renderConfidentialityCeiling?.atoms).toContainEqual({
      type: "https://commonfabric.org/cfc/atom/User",
      subject: session.as.did(),
    });
    expect(options.renderConfidentialityCeiling?.atoms).toContainEqual({
      type: "https://commonfabric.org/cfc/atom/PersonalSpace",
      owner: session.as.did(),
    });
    expect(options.renderConfidentialityCeiling?.atoms).toContain(
      session.as.did(),
    );
    // Influence-class caveat kinds are display-dischargeable (rendered
    // disclosure); material-risk kinds (e.g. injection-risk-unscreened) are
    // deliberately NOT allow-listed.
    expect(options.renderConfidentialityCeiling?.caveatKinds).toContain(
      "https://commonfabric.org/cfc/concepts/prompt-influence",
    );
    expect(options.renderConfidentialityCeiling?.caveatKinds).not.toContain(
      "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
    );

    const off = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      cfcRenderCeiling: false,
    });
    expect(off.renderDeclassificationPolicy).toBeUndefined();
    expect(off.renderConfidentialityCeiling).toBeUndefined();
  });

  it("builds the render ceiling for a host-supplied acting principal", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const delegate = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-render-ceiling-delegated",
    });

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      trustSnapshot: {
        id: `principal:${delegate.did()}`,
        actingPrincipal: delegate.did(),
      },
    });

    // A display sink's audience is whoever the runtime renders as, which a
    // delegated host names in its own trust snapshot rather than in the
    // session identity.
    expect(options.renderConfidentialityCeiling).toEqual(
      defaultRenderConfidentialityCeiling(delegate.did()),
    );
    expect(options.renderConfidentialityCeiling?.atoms).toContainEqual({
      type: "https://commonfabric.org/cfc/atom/User",
      subject: delegate.did(),
    });
    expect(options.renderConfidentialityCeiling?.atoms).not.toContainEqual({
      type: "https://commonfabric.org/cfc/atom/User",
      subject: session.as.did(),
    });
  });

  it("allows hosts to override CFC policy and trust snapshot", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-runtime-options",
    });
    const trustSnapshot = {
      id: "principal:loom-host",
      actingPrincipal: "did:key:z6MkLoomHost",
      revision: "loom-policy-v1",
    };

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "off",
      trustSnapshot,
    });

    expect(options.cfcEnforcementMode).toBe("observe");
    expect(options.cfcFlowLabels).toBe("off");
    expect(options.trustSnapshot).toBe(trustSnapshot);

    const withoutTrust = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      trustSnapshot: null,
    });
    expect(withoutTrust.trustSnapshot).toBeUndefined();
  });

  it("carries the worker-console flag onto the client options", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-forward-worker-console",
    });

    expect(
      createRuntimeClientOptions({
        session,
        apiUrl: new URL("http://shell.test/"),
        forwardWorkerConsole: true,
      }).forwardWorkerConsole,
    ).toBe(true);
    expect(
      createRuntimeClientOptions({
        session,
        apiUrl: new URL("http://shell.test/"),
      }).forwardWorkerConsole,
    ).toBeUndefined();
  });

  describe("create() forwards host flags to the worker", () => {
    // create() builds the client options and sends the Initialize request; this
    // covers that path end to end and asserts the host flags reach the worker.
    // A stub worker completes the READY handshake, then fails Initialize so
    // create() aborts without a real runtime.

    type CapturedInitData = {
      forwardWorkerConsole?: boolean;
      concurrentWatchRefresh?: boolean;
      renderDeclassificationPolicy?: string;
      renderConfidentialityCeiling?: {
        atoms?: unknown[];
        caveatKinds?: string[];
      };
    };

    it("includes forwardWorkerConsole, concurrentWatchRefresh, and the render ceiling in the Initialize request", async () => {
      const identity = await Identity.generate({ implementation: "noble" });

      const initRequests: Array<{ data: CapturedInitData }> = [];
      class StubWorker extends EventTarget {
        constructor(_url: URL | string) {
          super();
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                // Encoded, as a real worker posts it: the transport decodes
                // every arriving envelope, so a raw object reads as damaged.
                data: realmFromFabricValue({
                  type: TransportNotificationType.WorkerReady,
                }),
              }),
            )
          );
        }
        postMessage(encoded: unknown): void {
          const message = fabricFromRealmValue(encoded as never);
          const msg = message as {
            msgId?: number;
            data?: { type?: string; data?: CapturedInitData };
          };
          if (typeof msg?.msgId !== "number") return;
          if (msg.data?.type === "initialize") {
            initRequests.push(msg.data as { data: CapturedInitData });
          }
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: realmFromFabricValue({
                  msgId: msg.msgId!,
                  error: "stub init failure",
                }),
              }),
            )
          );
        }
        terminate(): void {}
      }

      const OriginalWorker = (globalThis as { Worker: unknown }).Worker;
      (globalThis as { Worker: unknown }).Worker = StubWorker;
      try {
        await expect(
          RuntimeInternals.create({
            identity,
            apiUrl: new URL("http://shell.test/"),
            workerUrl: new URL("http://shell.test/scripts/worker-runtime.js"),
            getBuildHash: () => Promise.resolve(undefined),
            forwardWorkerConsole: true,
            concurrentWatchRefresh: true,
            cfcRenderCeiling: true,
          }),
        ).rejects.toThrow("stub init failure");
      } finally {
        (globalThis as { Worker: unknown }).Worker = OriginalWorker;
      }

      expect(initRequests).toHaveLength(1);
      expect(initRequests[0].data.forwardWorkerConsole).toBe(true);
      // The dogfood storage toggle rides the same InitializationData path; the
      // worker maps it into StorageManager.open's experimentalConcurrentWatchRefresh.
      expect(initRequests[0].data.concurrentWatchRefresh).toBe(true);
      // Epic H3a: the ceiling crosses the worker IPC as InitializationData —
      // exactly the fields the worker-side reconciler consumes.
      expect(initRequests[0].data.renderDeclassificationPolicy).toBe("deny");
      expect(initRequests[0].data.renderConfidentialityCeiling).toEqual(
        defaultRenderConfidentialityCeiling(identity.did()),
      );
    });
  });

  describe("worker URL versioning", () => {
    // A deployed page must keep its worker and lazy chunks on the same
    // immutable module graph. Local/legacy builds retain the root worker URL
    // and manifest cache-buster.

    async function workerUrlFromCreate(
      options: {
        getBuildHash: () => Promise<string | undefined>;
        clientVersion?: string;
        useDefaultWorkerUrl?: boolean;
      },
    ): Promise<URL> {
      const identity = await Identity.generate({ implementation: "noble" });

      const capturedUrls: string[] = [];
      class StubWorker extends EventTarget {
        constructor(url: URL | string) {
          super();
          capturedUrls.push(String(url));
          // Error out before READY so create() aborts right after the worker
          // URL is built — this test only covers URL construction, not the
          // worker protocol.
          queueMicrotask(() => {
            this.dispatchEvent(
              new ErrorEvent("error", { message: "stub worker" }),
            );
          });
        }
        postMessage(): void {}
        terminate(): void {}
      }

      const OriginalWorker = globalThis.Worker;
      const locationGlobal = globalThis as unknown as {
        location: URL | undefined;
      };
      const originalLocation = locationGlobal.location;
      (globalThis as { Worker: unknown }).Worker = StubWorker;
      locationGlobal.location = new URL("http://shell.test/");
      try {
        await expect(RuntimeInternals.create({
          identity,
          apiUrl: new URL("http://shell.test/"),
          ...(options.useDefaultWorkerUrl ? {} : {
            workerUrl: new URL(
              "http://shell.test/scripts/worker-runtime.js",
            ),
          }),
          clientVersion: options.clientVersion,
          getBuildHash: options.getBuildHash,
        })).rejects.toThrow("stub worker");
      } finally {
        (globalThis as { Worker: unknown }).Worker = OriginalWorker;
        locationGlobal.location = originalLocation;
      }
      expect(capturedUrls).toHaveLength(1);
      return new URL(capturedUrls[0]);
    }

    it("keeps a deployed worker in its immutable build namespace", async () => {
      let calls = 0;
      const url = await workerUrlFromCreate({
        clientVersion: "commit-123",
        useDefaultWorkerUrl: true,
        getBuildHash: () => {
          calls += 1;
          return Promise.resolve("newer-root-hash");
        },
      });
      expect(calls).toBe(0);
      expect(url.pathname).toBe(
        "/builds/commit-123/scripts/worker-runtime.js",
      );
      expect(url.search).toBe("");
      expect(new URL("./chunk-COMPILER.js", url).pathname).toBe(
        "/builds/commit-123/scripts/chunk-COMPILER.js",
      );
    });

    it("cache-busts the mutable root fallback", async () => {
      let calls = 0;
      const url = await workerUrlFromCreate({
        useDefaultWorkerUrl: true,
        getBuildHash: () => {
          calls += 1;
          return Promise.resolve("hash-123");
        },
      });
      expect(calls).toBe(1);
      expect(url.pathname).toBe("/scripts/worker-runtime.js");
      expect(url.searchParams.get("v")).toBe("hash-123");
    });

    it("keeps an explicit worker URL when the manifest has no hash", async () => {
      const url = await workerUrlFromCreate({
        getBuildHash: () => Promise.resolve(undefined),
      });
      expect(url.pathname).toBe("/scripts/worker-runtime.js");
      expect(url.searchParams.has("v")).toBe(false);
    });

    it("keeps an explicit local worker URL with a build identifier", async () => {
      const url = await workerUrlFromCreate({
        clientVersion: "source-checkout-sha",
        getBuildHash: () => Promise.resolve("local-worker-hash"),
      });
      expect(url.pathname).toBe("/scripts/worker-runtime.js");
      expect(url.searchParams.get("v")).toBe("local-worker-hash");
    });
  });

  describe("getPattern start semantics", () => {
    // CT-1623: starting a piece is expensive (pattern instantiation + eager
    // dependency collection in the worker). Read-only consumers like the header
    // pieces menu must be able to resolve piece handles WITHOUT starting, and a
    // non-started cache entry must not block a later display-path start.

    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-pattern" as DID;

    function makeRuntime() {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      return { client, runtime };
    }

    it("starts by default (display path)", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1");
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("does not start when start: false (name listings)", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: false, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("upgrades a non-started cache entry when a starting caller asks", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        await runtime.getPattern(spaceDid, "piece-1");
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: false, space: spaceDid },
          { pieceId: "piece-1", runIt: true, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("serves started entries from cache for both kinds of callers", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1");
        await runtime.getPattern(spaceDid, "piece-1");
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("serves repeated non-started requests from cache", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: false, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("lifetime signal", () => {
    it("exposes the client's lifetime signal", async () => {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      try {
        expect(runtime.signal).toBe(client.signal);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("getPattern multi-space", () => {
    // One runtime serves every space; a pattern's address is (space, id)
    // and the cache is keyed by that address.

    const homeDid = "did:key:z6Mk-lib-shell-runtime-home" as DID;
    const otherDid = "did:key:z6Mk-lib-shell-runtime-other" as DID;

    function makeRuntime() {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      return { client, runtime };
    }

    it("passes the space through to the client", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(otherDid, "piece-1");
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: otherDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("caches per (space, id) — same id in two spaces are distinct", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(homeDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: homeDid },
          { pieceId: "piece-1", runIt: true, space: otherDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("invalidates per space", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(homeDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        runtime.invalidatePattern(otherDid, "piece-1");
        await runtime.getPattern(homeDid, "piece-1"); // still cached
        await runtime.getPattern(otherDid, "piece-1"); // re-fetched
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: homeDid },
          { pieceId: "piece-1", runIt: true, space: otherDid },
          { pieceId: "piece-1", runIt: true, space: otherDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("an embedder-supplied transport", () => {
    // A shell page normally boots a dedicated worker of its own. A page whose
    // runtime is already running in another document's worker is handed a
    // connection instead, and `attach` is what says which of the two this
    // page is: the client that stands a runtime up, or one joining the
    // runtime already there.

    type SentRequest = { type: string; data?: Record<string, unknown> };

    /**
     * A transport that answers every request with a bare ack, recording what
     * was asked. It stands for a connection already made, which is what an
     * embedder supplies.
     */
    class StubTransport extends EventEmitter<{ message: [unknown] }> {
      readonly sent: SentRequest[] = [];
      disposals = 0;

      send(message: unknown): void {
        // A transport is handed the envelope itself; encoding it is the
        // business of the transports that cross a realm boundary.
        const envelope = message as { msgId?: number; data?: SentRequest };
        if (envelope.data) this.sent.push(envelope.data);
        if (typeof envelope.msgId !== "number") return;
        queueMicrotask(() => this.emit("message", { msgId: envelope.msgId }));
      }

      dispose(): Promise<void> {
        this.disposals += 1;
        return Promise.resolve();
      }
    }

    /** Fails the test if anything reaches for a dedicated worker. */
    async function withNoWorkerConstructible<T>(
      run: () => Promise<T>,
    ): Promise<T> {
      const OriginalWorker = (globalThis as { Worker: unknown }).Worker;
      (globalThis as { Worker: unknown }).Worker = class {
        constructor() {
          throw new Error("a supplied transport must spawn no worker");
        }
      };
      try {
        return await run();
      } finally {
        (globalThis as { Worker: unknown }).Worker = OriginalWorker;
      }
    }

    it("attaches over the supplied transport, spawning no worker", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      const transport = new StubTransport();
      const runtime = await withNoWorkerConstructible(() =>
        RuntimeInternals.create({
          identity,
          apiUrl: new URL("http://shell.test/"),
          transport: transport as unknown as RuntimeTransport,
          attach: true,
        })
      );
      try {
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0].type).toBe("attach");
        // The acting principal crosses as the DID it derives to. An attach
        // asserts which principal the runtime acts as; it supplies no signer.
        expect(transport.sent[0].data?.identity).toBe(identity.did());
        expect(transport.sent[0].data?.spaceDid).toBe(identity.did());
        expect(transport.sent[0].data?.cfcEnforcementMode).toBe(
          "enforce-strict",
        );
        // The backend is posture, not routing: a document believing it reads
        // from somewhere else is as wrong about what it joined as one
        // believing another enforcement mode.
        expect(transport.sent[0].data?.apiUrl).toBe("http://shell.test/");
        // And no signer went with it. The initialize frame carries the key
        // pair; an attach carries a DID and nothing else of the identity.
        expect(transport.sent[0].data?.spaceIdentity).toBeUndefined();
        expect(typeof transport.sent[0].data?.identity).toBe("string");
      } finally {
        await runtime.dispose();
      }
    });

    it("refuses to attach with no transport to attach over", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      await expect(
        withNoWorkerConstructible(() =>
          RuntimeInternals.create({
            identity,
            apiUrl: new URL("http://shell.test/"),
            attach: true,
          })
        ),
      ).rejects.toThrow("`attach` needs a `transport`");
    });

    it("initializes over the supplied transport when not attaching", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      const transport = new StubTransport();
      const runtime = await withNoWorkerConstructible(() =>
        RuntimeInternals.create({
          identity,
          apiUrl: new URL("http://shell.test/"),
          transport: transport as unknown as RuntimeTransport,
        })
      );
      try {
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0].type).toBe("initialize");
      } finally {
        await runtime.dispose();
      }
    });
  });
});
