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
});
