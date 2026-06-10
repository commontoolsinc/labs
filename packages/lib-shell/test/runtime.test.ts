import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";

type MockRuntimeClientEvents = {
  console: [unknown];
  navigaterequest: [{ cell: { id(): string; space(): DID } }];
  error: [unknown];
  telemetry: [unknown];
};

class MockRuntimeClient {
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

  getPageSlug(pageId: string): Promise<string | undefined> {
    return Promise.resolve(this.slugByPageId.get(pageId));
  }

  /** Records every (pageId, runIt, space) so tests can assert which calls
   * START the piece (CT-1623: name listings must not start every piece) and
   * which space each call targets. */
  getPageCalls: Array<
    { pageId: string; runIt: boolean | undefined; space?: DID }
  > = [];

  getPage(
    pageId: string,
    runIt?: boolean,
    space?: DID,
  ): Promise<{ id: () => string }> {
    this.getPageCalls.push({
      pageId,
      runIt,
      ...(space !== undefined ? { space } : {}),
    });
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
  it("exposes page slug metadata", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    client.slugByPageId.set("piece-789", "demo");
    const runtime = new RuntimeInternals(
      client as any,
      spaceDid,
      undefined,
      false,
      spaceDid,
    );

    try {
      await expect(runtime.getSlug("piece-789")).resolves.toBe("demo");
    } finally {
      await runtime.dispose();
    }
  });

  it("guards removePage after dispose", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(
      client as any,
      spaceDid,
      undefined,
      false,
      spaceDid,
    );

    await runtime.dispose();

    await expect(runtime.removePage("piece-789")).rejects.toThrow(
      "RuntimeInternals disposed.",
    );
  });

  it("uses the default navigation event when no navigation callback is injected", async () => {
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav-current" as DID;
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(
      client as any,
      spaceDid,
      undefined,
      false,
      spaceDid,
    );

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
    const currentSpace = "did:key:z6Mk-lib-shell-runtime-current" as DID;
    const nextSpace = "did:key:z6Mk-lib-shell-runtime-next" as DID;
    const client = new MockRuntimeClient();
    const navigationReceived = deferred<NavigationDetail>();
    const runtime = new RuntimeInternals(
      client as any,
      currentSpace,
      "current-space",
      false,
      currentSpace,
      {
        navigate: (navigation) => {
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
      esmModuleLoader: true,
    };
    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      buildHash: "build-hash",
      experimental,
    });

    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
    expect(options.trustSnapshot).toEqual({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    });
    expect(options.spaceDid).toBe(session.space);
    expect(options.spaceName).toBe(session.spaceName);
    expect(options.buildHash).toBe("build-hash");
    expect(options.experimental).toBe(experimental);
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
      trustSnapshot,
    });

    expect(options.cfcEnforcementMode).toBe("observe");
    expect(options.trustSnapshot).toBe(trustSnapshot);

    const withoutTrust = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      trustSnapshot: null,
    });
    expect(withoutTrust.trustSnapshot).toBeUndefined();
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
      const runtime = new RuntimeInternals(
        client as any,
        spaceDid,
        undefined,
        false,
        spaceDid,
      );
      return { client, runtime };
    }

    it("starts by default (display path)", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern("piece-1");
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("does not start when start: false (name listings)", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern("piece-1", { start: false });
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: false },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("upgrades a non-started cache entry when a starting caller asks", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern("piece-1", { start: false });
        await runtime.getPattern("piece-1");
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: false },
          { pageId: "piece-1", runIt: true },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("serves started entries from cache for both kinds of callers", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern("piece-1");
        await runtime.getPattern("piece-1");
        await runtime.getPattern("piece-1", { start: false });
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("serves repeated non-started requests from cache", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern("piece-1", { start: false });
        await runtime.getPattern("piece-1", { start: false });
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: false },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  // §federation PR2: one worker serves patterns from many spaces. The
  // two-arg getPattern(space, id) form addresses another space; the
  // cache is keyed per (space, id) with the no-space form aliasing the
  // home space.
  describe("getPattern multi-space", () => {
    const homeDid = "did:key:z6Mk-lib-shell-runtime-home" as DID;
    const otherDid = "did:key:z6Mk-lib-shell-runtime-other" as DID;

    async function makeRuntime() {
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(
        client as any,
        homeDid,
        undefined,
        false,
        homeDid,
      );
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
        await runtime.getPattern("piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true },
          { pageId: "piece-1", runIt: true, space: otherDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("treats an explicit home space and the no-space form as one entry", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern("piece-1");
        await runtime.getPattern(homeDid, "piece-1");
        expect(client.getPageCalls.length).toBe(1);
      } finally {
        await runtime.dispose();
      }
    });

    it("invalidates per space", async () => {
      const { client, runtime } = await makeRuntime();
      try {
        await runtime.getPattern("piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        runtime.invalidatePattern("piece-1", otherDid);
        await runtime.getPattern("piece-1"); // still cached
        await runtime.getPattern(otherDid, "piece-1"); // re-fetched
        expect(client.getPageCalls).toEqual([
          { pageId: "piece-1", runIt: true },
          { pageId: "piece-1", runIt: true, space: otherDid },
          { pageId: "piece-1", runIt: true, space: otherDid },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
