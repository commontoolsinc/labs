import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import type { DID } from "@commonfabric/identity";
import { FavoritesManager } from "./favorites-manager.ts";
import type { RuntimeClient } from "./runtime-client.ts";

const space = "did:key:test-space" as DID;

// A handler stub that records what addFavorite sends.
class SendRecorder {
  sent: Array<Record<string, unknown>> = [];
  send(payload: Record<string, unknown>) {
    this.sent.push(payload);
  }
}

// A RuntimeClient stub exposing only what FavoritesManager.addFavorite touches:
// the home-pattern handle path (ensureHomePatternRunning → asSchema → key →
// handler) and getPage (whose resolved ref carries the piece's schema).
function stubRuntime(
  schema: JSONSchema | undefined,
  recorder: SendRecorder,
): { rt: RuntimeClient; getPageCalls: number } {
  let getPageCalls = 0;
  const homeHandle: Record<string, unknown> = {
    asSchema: () => homeHandle,
    sync: () => Promise.resolve(),
    key: () => recorder,
  };
  const rt = {
    ensureHomePatternRunning: () => Promise.resolve(homeHandle),
    getPage: () => {
      getPageCalls++;
      return Promise.resolve({
        cell: () => ({ ref: () => ({ schema }) }),
      });
    },
  } as unknown as RuntimeClient;
  return {
    rt,
    get getPageCalls() {
      return getPageCalls;
    },
  };
}

describe("FavoritesManager.addFavorite tag derivation", () => {
  it("derives structured tags from the piece schema", async () => {
    const recorder = new SendRecorder();
    const { rt } = stubRuntime({
      type: "object",
      description: "A #note",
      tags: ["search", "discovery"],
    }, recorder);

    await new FavoritesManager(rt).addFavorite(space, "piece-1");

    expect(recorder.sent.length).toBe(1);
    expect(recorder.sent[0].tags).toEqual(["search", "discovery"]);
    expect(recorder.sent[0].piece).toMatchObject({ id: "of:piece-1", space });
  });

  it("falls back to description hashtags for legacy schemas", async () => {
    const recorder = new SendRecorder();
    const { rt } = stubRuntime({
      type: "object",
      description: "An #annotation piece.",
    }, recorder);

    await new FavoritesManager(rt).addFavorite(space, "piece-2");

    expect(recorder.sent[0].tags).toEqual(["annotation"]);
  });

  it("prefers an explicit tag over the schema and skips the schema read", async () => {
    const recorder = new SendRecorder();
    const stub = stubRuntime(
      { type: "object", tags: ["schema-tag"] },
      recorder,
    );

    await new FavoritesManager(stub.rt).addFavorite(
      space,
      "piece-3",
      "#Custom-Tag",
    );

    expect(recorder.sent[0].tags).toEqual(["custom-tag"]);
    // An explicit tag short-circuits derivation; getPage is never called.
    expect(stub.getPageCalls).toBe(0);
  });

  it("stores no tags when the piece has no readable schema", async () => {
    const recorder = new SendRecorder();
    const { rt } = stubRuntime(undefined, recorder);

    await new FavoritesManager(rt).addFavorite(space, "piece-4");

    expect(recorder.sent[0].tags).toEqual([]);
  });
});
