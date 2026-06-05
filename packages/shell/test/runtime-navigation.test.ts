import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { EventEmitter } from "../../runtime-client/client/emitter.ts";

const env = globalThis as typeof globalThis & {
  $API_URL?: string;
  $ENVIRONMENT?: string;
};
env.$API_URL ??= "http://shell.test/";
env.$ENVIRONMENT ??= "development";

type MockRuntimeClientEvents = {
  console: [unknown];
  navigaterequest: [{ cell: { id(): string; space(): DID } }];
  error: [unknown];
  telemetry: [unknown];
};

class MockRuntimeClient extends EventEmitter<MockRuntimeClientEvents> {
  idleCalls = 0;
  syncedCalls = 0;
  slugByPageId = new Map<string, string | undefined>();

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
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type NavigationDetail = {
  spaceDid: DID;
  pieceId: string;
};

describe("RuntimeInternals navigation", () => {
  it("exposes page slug metadata", async () => {
    const { RuntimeInternals } = await import("../src/lib/runtime.ts");
    const spaceDid = "did:key:z6Mk-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    client.slugByPageId.set("piece-789", "demo");
    const runtime = new (RuntimeInternals as any)(
      client,
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

  it("does not block same-space navigation on piece registration", async () => {
    const env = globalThis as typeof globalThis & {
      $API_URL?: string;
      $ENVIRONMENT?: string;
      $COMMIT_SHA?: string;
      $MEMORY_VERSION?: string;
      $EXPERIMENTAL_MODERN_CELL_REP?: string;
      $COMPILATION_CACHE_CLIENT?: string;
    };
    const originalEnv = {
      $API_URL: env.$API_URL,
      $ENVIRONMENT: env.$ENVIRONMENT,
      $COMMIT_SHA: env.$COMMIT_SHA,
      $MEMORY_VERSION: env.$MEMORY_VERSION,
      $EXPERIMENTAL_MODERN_CELL_REP: env.$EXPERIMENTAL_MODERN_CELL_REP,
      $COMPILATION_CACHE_CLIENT: env.$COMPILATION_CACHE_CLIENT,
    };
    env.$API_URL = "http://shell.test/";
    env.$ENVIRONMENT = "development";
    env.$COMMIT_SHA = undefined;
    env.$MEMORY_VERSION = undefined;
    env.$EXPERIMENTAL_MODERN_CELL_REP = undefined;
    env.$COMPILATION_CACHE_CLIENT = undefined;

    const { RuntimeInternals } = await import("../src/lib/runtime.ts");
    const spaceDid = "did:key:z6Mk-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    const runtime = new (RuntimeInternals as any)(
      client,
      spaceDid,
      undefined,
      false,
      spaceDid,
    );

    let registrations = 0;
    const registrationStarted = deferred<void>();
    const registrationReleased = deferred<void>();
    runtime.registerNavigatedPiece = async () => {
      registrations += 1;
      registrationStarted.resolve();
      await registrationReleased.promise;
    };

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

      await registrationStarted.promise;

      expect(registrations).toBe(1);
      await navigationReceived.promise;
      expect(client.idleCalls).toBe(1);
      expect(client.syncedCalls).toBe(1);
      expect(navigation).toEqual({
        spaceDid,
        pieceId: "piece-123",
      });
      registrationReleased.resolve();
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
      env.$API_URL = originalEnv.$API_URL;
      env.$ENVIRONMENT = originalEnv.$ENVIRONMENT;
      env.$COMMIT_SHA = originalEnv.$COMMIT_SHA;
      env.$MEMORY_VERSION = originalEnv.$MEMORY_VERSION;
      env.$EXPERIMENTAL_MODERN_CELL_REP =
        originalEnv.$EXPERIMENTAL_MODERN_CELL_REP;
      env.$COMPILATION_CACHE_CLIENT = originalEnv.$COMPILATION_CACHE_CLIENT;
      await runtime.dispose();
    }
  });

  it("waits for the current runtime to settle before cross-space navigation", async () => {
    const env = globalThis as typeof globalThis & {
      $API_URL?: string;
      $ENVIRONMENT?: string;
      $COMMIT_SHA?: string;
      $MEMORY_VERSION?: string;
      $EXPERIMENTAL_MODERN_CELL_REP?: string;
      $COMPILATION_CACHE_CLIENT?: string;
    };
    const originalEnv = {
      $API_URL: env.$API_URL,
      $ENVIRONMENT: env.$ENVIRONMENT,
      $COMMIT_SHA: env.$COMMIT_SHA,
      $MEMORY_VERSION: env.$MEMORY_VERSION,
      $EXPERIMENTAL_MODERN_CELL_REP: env.$EXPERIMENTAL_MODERN_CELL_REP,
      $COMPILATION_CACHE_CLIENT: env.$COMPILATION_CACHE_CLIENT,
    };
    env.$API_URL = "http://shell.test/";
    env.$ENVIRONMENT = "development";
    env.$COMMIT_SHA = undefined;
    env.$MEMORY_VERSION = undefined;
    env.$EXPERIMENTAL_MODERN_CELL_REP = undefined;
    env.$COMPILATION_CACHE_CLIENT = undefined;

    const { RuntimeInternals } = await import("../src/lib/runtime.ts");
    const currentSpace = "did:key:z6Mk-shell-runtime-did-nav-current" as DID;
    const nextSpace = "did:key:z6Mk-shell-runtime-did-nav-next" as DID;
    const client = new MockRuntimeClient();
    const runtime = new (RuntimeInternals as any)(
      client,
      currentSpace,
      "current-space",
      false,
      currentSpace,
    );

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
          id: () => "piece-456",
          space: () => nextSpace,
        },
      });

      await navigationReceived.promise;

      expect(client.idleCalls).toBe(1);
      expect(client.syncedCalls).toBe(1);
      expect(navigation).toEqual({
        spaceDid: nextSpace,
        pieceId: "piece-456",
      });
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
      env.$API_URL = originalEnv.$API_URL;
      env.$ENVIRONMENT = originalEnv.$ENVIRONMENT;
      env.$COMMIT_SHA = originalEnv.$COMMIT_SHA;
      env.$MEMORY_VERSION = originalEnv.$MEMORY_VERSION;
      env.$EXPERIMENTAL_MODERN_CELL_REP =
        originalEnv.$EXPERIMENTAL_MODERN_CELL_REP;
      env.$COMPILATION_CACHE_CLIENT = originalEnv.$COMPILATION_CACHE_CLIENT;
      await runtime.dispose();
    }
  });

  it("creates worker runtime options with explicit CFC enforcement and principal trust", async () => {
    const { createRuntimeClientOptions } = await import(
      "../src/lib/runtime.ts"
    );
    const { createSession, Identity } = await import(
      "@commonfabric/identity"
    );

    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "shell-cfc-runtime-options",
    });

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      buildHash: "build-hash",
    });

    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
    expect(options.trustSnapshot).toEqual({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    });
    expect(options.spaceDid).toBe(session.space);
    expect(options.spaceName).toBe(session.spaceName);
    expect(options.buildHash).toBe("build-hash");
  });
});
