import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";

type MockRuntimeClientEvents = {
  console: [unknown];
  navigaterequest: [{ cell: { id(): string; space(): DID } }];
  error: [unknown];
  telemetry: [unknown];
  versionskew: [unknown];
};

class MockRuntimeClient {
  readonly signal: AbortSignal = new AbortController().signal;
  idleCalls = 0;
  syncedCalls = 0;
  slugByPageId = new Map<string, string | undefined>();
  private handlers = new Map<
    keyof MockRuntimeClientEvents,
    Array<(...args: unknown[]) => void>
  >();

  on<K extends keyof MockRuntimeClientEvents>(
    event: K,
    handler: (...args: MockRuntimeClientEvents[K]) => void,
  ): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.handlers.set(event, handlers);
  }

  emit<K extends keyof MockRuntimeClientEvents>(
    event: K,
    ...args: MockRuntimeClientEvents[K]
  ): void {
    for (const handler of this.handlers.get(event) ?? []) {
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

  getPageSlug(pageId: string): Promise<string | undefined> {
    return Promise.resolve(this.slugByPageId.get(pageId));
  }

  /** Records which space each root-pattern request targeted. */
  spaceRootCalls: DID[] = [];

  getSpaceRootPattern(space: DID): Promise<never> {
    this.spaceRootCalls.push(space);
    // Reject so registerNavigatedPiece's try/catch absorbs it — the
    // tests only assert WHERE the registration was addressed.
    return Promise.reject(new Error("no root pattern in mock"));
  }

  /** Records every (pageId, runIt, space) so tests can assert which calls
   * START the piece (CT-1623: name listings must not start every piece) and
   * which space each call targets. */
  getPageCalls: Array<
    { pageId: string; runIt: boolean | undefined; space: DID }
  > = [];

  getPage(
    pageId: string,
    space: DID,
    runIt?: boolean,
  ): Promise<{ id: () => string }> {
    this.getPageCalls.push({ pageId, runIt, space });
    return Promise.resolve({ id: () => pageId });
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
  it("resolves named spaces through the worker client", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
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

  it("exposes page slug metadata", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    client.slugByPageId.set("piece-789", "demo");
    const runtime = new RuntimeInternals(client as any);

    try {
      await expect(runtime.getSlug(spaceDid, "piece-789")).resolves.toBe(
        "demo",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("guards removePage after dispose", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);

    await runtime.dispose();

    await expect(runtime.removePage(spaceDid, "piece-789")).rejects.toThrow(
      "RuntimeInternals disposed.",
    );
  });

  it("uses the default navigation event when no navigation callback is injected", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav-current" as DID;
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);

    runtime.registerNavigatedPiece = async () => {};

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
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
      await runtime.dispose();
    }
  });

  it("uses an injected navigation callback", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
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

  it("forwards a client versionskew event to the onVersionSkew callback", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const client = new MockRuntimeClient();
    const received: unknown[] = [];
    const runtime = new RuntimeInternals(client as any, {
      onVersionSkew: (event) => received.push(event),
    });
    try {
      const event = {
        space: "did:key:z6Mk-skew",
        clientVersion: "c",
        toolshedVersion: "t",
      };
      client.emit("versionskew", event);
      expect(received).toEqual([event]);
    } finally {
      await runtime.dispose();
    }
  });

  it("logs a navigation-convergence failure without escaping as unhandled", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const space = "did:key:z6Mk-lib-shell-nav-fail" as DID;
    const client = new MockRuntimeClient();
    client.synced = () => Promise.reject(new Error("convergence failed"));

    let navigated = false;
    const runtime = new RuntimeInternals(client as any, {
      navigate: () => {
        navigated = true;
      },
    });
    // Isolate #handleNavigateRequest from the mock's rejecting root pattern.
    runtime.registerNavigatedPiece = async () => {};

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
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
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
    runtime.registerNavigatedPiece = async () => {};

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
    const { createRuntimeClientOptions } = await import(
      "@commonfabric/lib-shell"
    );
    const { createSession, Identity } = await import(
      "@commonfabric/identity"
    );

    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-runtime-options",
    });

    const experimental = {
      modernCellRep: true,
      persistentSchedulerState: false,
    };
    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      experimental,
    });

    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
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
    // Epic H3a: the render ceiling is a dogfood flag, default OFF — absent
    // fields keep today's unbounded rendering (no ceiling, author
    // declassification honored).
    expect(options.renderDeclassificationPolicy).toBeUndefined();
    expect(options.renderConfidentialityCeiling).toBeUndefined();
  });

  it("populates the §8.10.6 render ceiling when cfcRenderCeiling is on", async () => {
    const { createRuntimeClientOptions, defaultRenderConfidentialityCeiling } =
      await import("@commonfabric/lib-shell");
    const { createSession, Identity } = await import(
      "@commonfabric/identity"
    );

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

  it("allows hosts to override CFC policy and trust snapshot", async () => {
    const { createRuntimeClientOptions } = await import(
      "@commonfabric/lib-shell"
    );
    const { createSession, Identity } = await import(
      "@commonfabric/identity"
    );

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
    const { createRuntimeClientOptions } = await import(
      "@commonfabric/lib-shell"
    );
    const { createSession, Identity } = await import("@commonfabric/identity");
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

  // create() builds the client options and sends the Initialize request; this
  // covers that path end to end and asserts the host flags reach the worker.
  // A stub worker completes the READY handshake, then fails Initialize so
  // create() aborts without a real runtime.
  describe("create() forwards host flags to the worker", () => {
    type CapturedInitData = {
      forwardWorkerConsole?: boolean;
      renderDeclassificationPolicy?: string;
      renderConfidentialityCeiling?: {
        atoms?: unknown[];
        caveatKinds?: string[];
      };
    };

    it("includes forwardWorkerConsole and the render ceiling in the Initialize request", async () => {
      const { RuntimeInternals, defaultRenderConfidentialityCeiling } =
        await import("@commonfabric/lib-shell");
      const { Identity } = await import("@commonfabric/identity");
      const identity = await Identity.generate({ implementation: "noble" });

      const initRequests: Array<{ data: CapturedInitData }> = [];
      class StubWorker extends EventTarget {
        constructor(_url: URL | string) {
          super();
          queueMicrotask(() =>
            this.dispatchEvent(new MessageEvent("message", { data: "READY" }))
          );
        }
        postMessage(message: unknown): void {
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
                data: { msgId: msg.msgId, error: "stub init failure" },
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
            cfcRenderCeiling: true,
          }),
        ).rejects.toThrow("stub init failure");
      } finally {
        (globalThis as { Worker: unknown }).Worker = OriginalWorker;
      }

      expect(initRequests).toHaveLength(1);
      expect(initRequests[0].data.forwardWorkerConsole).toBe(true);
      // Epic H3a: the ceiling crosses the worker IPC as InitializationData —
      // exactly the fields the worker-side reconciler consumes.
      expect(initRequests[0].data.renderDeclassificationPolicy).toBe("deny");
      expect(initRequests[0].data.renderConfidentialityCeiling).toEqual(
        defaultRenderConfidentialityCeiling(identity.did()),
      );
    });
  });

  // A deployed page must keep its worker and lazy chunks on the same immutable
  // module graph. Local/legacy builds retain the root worker URL and manifest
  // cache-buster.
  describe("worker URL versioning", () => {
    async function workerUrlFromCreate(
      options: {
        getBuildHash: () => Promise<string | undefined>;
        clientVersion?: string;
        useDefaultWorkerUrl?: boolean;
      },
    ): Promise<URL> {
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const { Identity } = await import("@commonfabric/identity");
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
  });

  // CT-1623: starting a piece is expensive (pattern instantiation + eager
  // dependency collection in the worker). Read-only consumers like the header
  // pieces menu must be able to resolve page handles WITHOUT starting, and a
  // non-started cache entry must not block a later display-path start.
  describe("getPattern start semantics", () => {
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-pattern" as DID;

    async function makeRuntime() {
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      return { client, runtime };
    }

    it("starts by default (display path)", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1");
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("does not start when start: false (name listings)", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: false, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("upgrades a non-started cache entry when a starting caller asks", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        await runtime.getPattern(spaceDid, "piece-1");
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: false, space: spaceDid },
          { pageId: "piece-1", runIt: true, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("serves started entries from cache for both kinds of callers", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1");
        await runtime.getPattern(spaceDid, "piece-1");
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("serves repeated non-started requests from cache", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: false, space: spaceDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  // A navigated piece registers in ITS OWN space's root pattern — the
  // cell's space, not any notion of a current space.
  describe("registerNavigatedPiece", () => {
    it("targets the navigated cell's space", async () => {
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      const cellSpace = "did:key:z6Mk-lib-shell-runtime-foreign" as DID;
      try {
        await runtime.registerNavigatedPiece(
          {
            id: () => "piece-9",
            space: () => cellSpace,
          } as any,
        );
        expect(client.spaceRootCalls).toEqual([cellSpace]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("lifetime signal", () => {
    it("exposes the client's lifetime signal", async () => {
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      try {
        expect(runtime.signal).toBe(client.signal);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("trackRecentPiece", () => {
    it("absorbs a failed root-pattern lookup and logs once while alive", async () => {
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-lib-shell-runtime-recent" as DID;

      const errors: unknown[][] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errors.push(args);
      try {
        // getSpaceRootPattern rejects in the mock; the catch absorbs it and
        // logs once because the runtime is still alive.
        await runtime.trackRecentPiece(space, "piece-recent");
        expect(client.spaceRootCalls).toEqual([space]);
        expect(errors.length).toBe(1);
      } finally {
        console.error = originalError;
        await runtime.dispose();
      }
    });

    it("stays silent when the lookup fails after disposal", async () => {
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-lib-shell-runtime-recent-disposed" as DID;
      // Reject only after the runtime has been disposed, so the catch takes
      // the silent branch.
      let rejectRoot!: (error: unknown) => void;
      client.getSpaceRootPattern = (s: DID) => {
        client.spaceRootCalls.push(s);
        return new Promise<never>((_, reject) => {
          rejectRoot = reject;
        });
      };

      const errors: unknown[][] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errors.push(args);
      try {
        const tracking = runtime.trackRecentPiece(space, "piece-recent");
        await runtime.dispose();
        rejectRoot(new Error("no root pattern in mock"));
        await tracking;
        expect(errors.length).toBe(0);
      } finally {
        console.error = originalError;
      }
    });
  });

  // One runtime serves every space; a pattern's address is (space, id)
  // and the cache is keyed by that address.
  describe("getPattern multi-space", () => {
    const homeDid = "did:key:z6Mk-lib-shell-runtime-home" as DID;
    const otherDid = "did:key:z6Mk-lib-shell-runtime-other" as DID;

    async function makeRuntime() {
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      return { client, runtime };
    }

    it("passes the space through to the client", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern(otherDid, "piece-1");
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true, space: otherDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("caches per (space, id) — same id in two spaces are distinct", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern(homeDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true, space: homeDid },
          { pageId: "piece-1", runIt: true, space: otherDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("invalidates per space", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern(homeDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        runtime.invalidatePattern(otherDid, "piece-1");
        await runtime.getPattern(homeDid, "piece-1"); // still cached
        await runtime.getPattern(otherDid, "piece-1"); // re-fetched
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true, space: homeDid },
          { pageId: "piece-1", runIt: true, space: otherDid },
          { pageId: "piece-1", runIt: true, space: otherDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
