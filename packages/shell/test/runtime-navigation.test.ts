import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { EventEmitter } from "../../runtime-client/client/emitter.ts";

type MockRuntimeClientEvents = {
  console: [unknown];
  navigaterequest: [{ cell: { id(): string; space(): DID } }];
  error: [unknown];
  telemetry: [unknown];
};

class MockRuntimeClient extends EventEmitter<MockRuntimeClientEvents> {
  idleCalls = 0;
  syncedCalls = 0;

  idle(): Promise<void> {
    this.idleCalls += 1;
    return Promise.resolve();
  }

  synced(): Promise<void> {
    this.syncedCalls += 1;
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("RuntimeInternals navigation", () => {
  it("registers same-space navigations when the active view is keyed by DID", async () => {
    const env = globalThis as typeof globalThis & {
      $API_URL?: string;
      $ENVIRONMENT?: string;
      $COMMIT_SHA?: string;
      $MEMORY_VERSION?: string;
      $EXPERIMENTAL_MODERN_DATA_MODEL?: string;
      $EXPERIMENTAL_UNIFIED_JSON_ENCODING?: string;
      $EXPERIMENTAL_MODERN_SCHEMA_HASH?: string;
      $EXPERIMENTAL_MODERN_HASH?: string;
      $COMPILATION_CACHE_CLIENT?: string;
    };
    const originalEnv = {
      $API_URL: env.$API_URL,
      $ENVIRONMENT: env.$ENVIRONMENT,
      $COMMIT_SHA: env.$COMMIT_SHA,
      $MEMORY_VERSION: env.$MEMORY_VERSION,
      $EXPERIMENTAL_MODERN_DATA_MODEL: env.$EXPERIMENTAL_MODERN_DATA_MODEL,
      $EXPERIMENTAL_UNIFIED_JSON_ENCODING:
        env.$EXPERIMENTAL_UNIFIED_JSON_ENCODING,
      $EXPERIMENTAL_MODERN_SCHEMA_HASH: env.$EXPERIMENTAL_MODERN_SCHEMA_HASH,
      $EXPERIMENTAL_MODERN_HASH: env.$EXPERIMENTAL_MODERN_HASH,
      $COMPILATION_CACHE_CLIENT: env.$COMPILATION_CACHE_CLIENT,
    };
    env.$API_URL = "http://shell.test/";
    env.$ENVIRONMENT = "development";
    env.$COMMIT_SHA = undefined;
    env.$MEMORY_VERSION = undefined;
    env.$EXPERIMENTAL_MODERN_DATA_MODEL = undefined;
    env.$EXPERIMENTAL_UNIFIED_JSON_ENCODING = undefined;
    env.$EXPERIMENTAL_MODERN_SCHEMA_HASH = undefined;
    env.$EXPERIMENTAL_MODERN_HASH = undefined;
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
    runtime.registerNavigatedPiece = () => {
      registrations += 1;
    };

    let navigation:
      | {
        spaceDid: DID;
        pieceId: string;
      }
      | undefined;
    const onNavigate = (event: Event) => {
      navigation = (event as CustomEvent<typeof navigation>).detail;
    };
    globalThis.addEventListener("cf-navigate", onNavigate);

    try {
      client.emit("navigaterequest", {
        cell: {
          id: () => "piece-123",
          space: () => spaceDid,
        },
      });

      await Promise.resolve();

      expect(registrations).toBe(1);
      expect(client.idleCalls).toBe(0);
      expect(client.syncedCalls).toBe(0);
      expect(navigation).toEqual({
        spaceDid,
        pieceId: "piece-123",
      });
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
      env.$API_URL = originalEnv.$API_URL;
      env.$ENVIRONMENT = originalEnv.$ENVIRONMENT;
      env.$COMMIT_SHA = originalEnv.$COMMIT_SHA;
      env.$MEMORY_VERSION = originalEnv.$MEMORY_VERSION;
      env.$EXPERIMENTAL_MODERN_DATA_MODEL =
        originalEnv.$EXPERIMENTAL_MODERN_DATA_MODEL;
      env.$EXPERIMENTAL_UNIFIED_JSON_ENCODING =
        originalEnv.$EXPERIMENTAL_UNIFIED_JSON_ENCODING;
      env.$EXPERIMENTAL_MODERN_SCHEMA_HASH =
        originalEnv.$EXPERIMENTAL_MODERN_SCHEMA_HASH;
      env.$EXPERIMENTAL_MODERN_HASH = originalEnv.$EXPERIMENTAL_MODERN_HASH;
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
      $EXPERIMENTAL_MODERN_DATA_MODEL?: string;
      $EXPERIMENTAL_UNIFIED_JSON_ENCODING?: string;
      $EXPERIMENTAL_MODERN_SCHEMA_HASH?: string;
      $EXPERIMENTAL_MODERN_HASH?: string;
      $COMPILATION_CACHE_CLIENT?: string;
    };
    const originalEnv = {
      $API_URL: env.$API_URL,
      $ENVIRONMENT: env.$ENVIRONMENT,
      $COMMIT_SHA: env.$COMMIT_SHA,
      $MEMORY_VERSION: env.$MEMORY_VERSION,
      $EXPERIMENTAL_MODERN_DATA_MODEL: env.$EXPERIMENTAL_MODERN_DATA_MODEL,
      $EXPERIMENTAL_UNIFIED_JSON_ENCODING:
        env.$EXPERIMENTAL_UNIFIED_JSON_ENCODING,
      $EXPERIMENTAL_MODERN_SCHEMA_HASH: env.$EXPERIMENTAL_MODERN_SCHEMA_HASH,
      $EXPERIMENTAL_MODERN_HASH: env.$EXPERIMENTAL_MODERN_HASH,
      $COMPILATION_CACHE_CLIENT: env.$COMPILATION_CACHE_CLIENT,
    };
    env.$API_URL = "http://shell.test/";
    env.$ENVIRONMENT = "development";
    env.$COMMIT_SHA = undefined;
    env.$MEMORY_VERSION = undefined;
    env.$EXPERIMENTAL_MODERN_DATA_MODEL = undefined;
    env.$EXPERIMENTAL_UNIFIED_JSON_ENCODING = undefined;
    env.$EXPERIMENTAL_MODERN_SCHEMA_HASH = undefined;
    env.$EXPERIMENTAL_MODERN_HASH = undefined;
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

    let navigation:
      | {
        spaceDid: DID;
        pieceId: string;
      }
      | undefined;
    const onNavigate = (event: Event) => {
      navigation = (event as CustomEvent<typeof navigation>).detail;
    };
    globalThis.addEventListener("cf-navigate", onNavigate);

    try {
      client.emit("navigaterequest", {
        cell: {
          id: () => "piece-456",
          space: () => nextSpace,
        },
      });

      await Promise.resolve();
      await Promise.resolve();

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
      env.$EXPERIMENTAL_MODERN_DATA_MODEL =
        originalEnv.$EXPERIMENTAL_MODERN_DATA_MODEL;
      env.$EXPERIMENTAL_UNIFIED_JSON_ENCODING =
        originalEnv.$EXPERIMENTAL_UNIFIED_JSON_ENCODING;
      env.$EXPERIMENTAL_MODERN_SCHEMA_HASH =
        originalEnv.$EXPERIMENTAL_MODERN_SCHEMA_HASH;
      env.$EXPERIMENTAL_MODERN_HASH = originalEnv.$EXPERIMENTAL_MODERN_HASH;
      env.$COMPILATION_CACHE_CLIENT = originalEnv.$COMPILATION_CACHE_CLIENT;
      await runtime.dispose();
    }
  });
});
