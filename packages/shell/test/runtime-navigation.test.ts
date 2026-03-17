import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commontools/identity";
import { EventEmitter } from "../../runtime-client/client/emitter.ts";

type MockRuntimeClientEvents = {
  console: [unknown];
  navigaterequest: [{ cell: { id(): string; space(): DID } }];
  error: [unknown];
  telemetry: [unknown];
};

class MockRuntimeClient extends EventEmitter<MockRuntimeClientEvents> {
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
      $EXPERIMENTAL_RICH_STORABLE_VALUES?: string;
      $EXPERIMENTAL_STORABLE_PROTOCOL?: string;
      $EXPERIMENTAL_UNIFIED_JSON_ENCODING?: string;
      $EXPERIMENTAL_CANONICAL_HASHING?: string;
      $COMPILATION_CACHE_CLIENT?: string;
    };
    env.$API_URL = "http://shell.test/";
    env.$ENVIRONMENT = "development";
    env.$COMMIT_SHA = undefined;
    env.$MEMORY_VERSION = undefined;
    env.$EXPERIMENTAL_RICH_STORABLE_VALUES = undefined;
    env.$EXPERIMENTAL_STORABLE_PROTOCOL = undefined;
    env.$EXPERIMENTAL_UNIFIED_JSON_ENCODING = undefined;
    env.$EXPERIMENTAL_CANONICAL_HASHING = undefined;
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
    runtime.registerNavigatedPiece = async () => {
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
    globalThis.addEventListener("ct-navigate", onNavigate);

    try {
      client.emit("navigaterequest", {
        cell: {
          id: () => "piece-123",
          space: () => spaceDid,
        },
      });

      await Promise.resolve();

      expect(registrations).toBe(1);
      expect(navigation).toEqual({
        spaceDid,
        pieceId: "piece-123",
      });
    } finally {
      globalThis.removeEventListener("ct-navigate", onNavigate);
      await runtime.dispose();
    }
  });
});
