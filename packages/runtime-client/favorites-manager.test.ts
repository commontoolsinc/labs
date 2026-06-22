import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import type { DID } from "@commonfabric/identity";
import { FavoritesManager } from "./favorites-manager.ts";
import type { RuntimeClient } from "./runtime-client.ts";
import { RuntimeDisposedError } from "./shared/disposed-error.ts";

const space = "did:key:test-space" as DID;

interface StubOptions {
  schema?: JSONSchema; // schema carried on the resolved piece ref
  name?: string; // value returned by the resolved piece's $NAME cell
  getPageThrows?: boolean; // make getPage reject (derivation error path)
  favorites?: unknown; // value returned by the favorites cell
  ensureThrows?: boolean; // make ensureHomePatternRunning reject
  ensureDisposed?: boolean; // reject with a RuntimeDisposedError
}

// A single flexible RuntimeClient stub covering everything FavoritesManager
// touches: the home-pattern handle chain (ensureHomePatternRunning → asSchema →
// key → handler / favorites cell) and getPage (whose resolved ref carries the
// piece schema).
function makeStub(opts: StubOptions = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let subscribeCb: ((v: unknown) => void) | undefined;
  let unsubscribed = false;
  let getPageCalls = 0;

  const handler = { send: (p: Record<string, unknown>) => sent.push(p) };
  const favoritesCell: Record<string, unknown> = {
    asSchema: () => favoritesCell,
    sync: () => Promise.resolve(),
    get: () => opts.favorites,
    subscribe: (cb: (v: unknown) => void) => {
      subscribeCb = cb;
      return () => {
        unsubscribed = true;
      };
    },
  };
  const homeHandle: Record<string, unknown> = {
    asSchema: () => homeHandle,
    sync: () => Promise.resolve(),
    key: (k: string) => (k === "favorites" ? favoritesCell : handler),
  };
  const rt = {
    ensureHomePatternRunning: () =>
      opts.ensureDisposed
        ? Promise.reject(new RuntimeDisposedError("disposed"))
        : opts.ensureThrows
        ? Promise.reject(new Error("ensure failed"))
        : Promise.resolve(homeHandle),
    getPage: () => {
      getPageCalls++;
      return opts.getPageThrows
        ? Promise.reject(new Error("getPage failed"))
        : Promise.resolve({
          cell: () => ({
            ref: () => ({ schema: opts.schema }),
            asSchema: () => ({
              sync: () => Promise.resolve({ $NAME: opts.name }),
            }),
          }),
        });
    },
  } as unknown as RuntimeClient;

  return {
    rt,
    sent,
    invokeSubscribe: (v: unknown) => subscribeCb?.(v),
    hasSubscriber: () => subscribeCb !== undefined,
    wasUnsubscribed: () => unsubscribed,
    getPageCalls: () => getPageCalls,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FavoritesManager.addFavorite tag derivation", () => {
  it("derives structured tags from the piece schema", async () => {
    const stub = makeStub({
      schema: {
        type: "object",
        description: "A #note",
        tags: ["search", "go"],
      },
      name: "Search Piece",
    });
    await new FavoritesManager(stub.rt).addFavorite(space, "piece-1");
    expect(stub.sent[0].tags).toEqual(["search", "go"]);
    expect(stub.sent[0].name).toEqual("Search Piece");
    expect(stub.sent[0].piece).toMatchObject({ id: "of:piece-1", space });
  });

  it("prefers an explicit tag and skips the schema read", async () => {
    const stub = makeStub({ schema: { type: "object", tags: ["schema-tag"] } });
    await new FavoritesManager(stub.rt).addFavorite(space, "p", "#Custom-Tag");
    expect(stub.sent[0].tags).toEqual(["custom-tag"]);
    expect(stub.getPageCalls()).toBe(0);
  });

  it("stores no tags when the piece has no readable schema", async () => {
    const stub = makeStub({ schema: undefined });
    await new FavoritesManager(stub.rt).addFavorite(space, "p");
    expect(stub.sent[0].tags).toEqual([]);
  });

  it("stores no tags when the schema read fails", async () => {
    const stub = makeStub({ getPageThrows: true });
    await new FavoritesManager(stub.rt).addFavorite(space, "p");
    expect(stub.sent[0].tags).toEqual([]);
  });
});

describe("FavoritesManager other operations", () => {
  it("removeFavorite sends the piece reference", async () => {
    const stub = makeStub();
    await new FavoritesManager(stub.rt).removeFavorite(space, "piece-x");
    expect(stub.sent[0]).toMatchObject({
      piece: { id: "of:piece-x", space },
    });
  });

  it("getFavorites returns the favorites list", async () => {
    const entries = [{ cell: {}, tags: ["a"], userTags: [] }];
    const stub = makeStub({ favorites: entries });
    const result = await new FavoritesManager(stub.rt).getFavorites();
    expect(result).toEqual(entries);
  });

  it("getFavorites returns [] when the cell is empty", async () => {
    const stub = makeStub({ favorites: undefined });
    expect(await new FavoritesManager(stub.rt).getFavorites()).toEqual([]);
  });

  it("subscribeFavorites delivers values and stops on unsubscribe", async () => {
    const stub = makeStub();
    const seen: unknown[] = [];
    const cancel = new FavoritesManager(stub.rt).subscribeFavorites((f) =>
      seen.push(f)
    );
    await tick();
    expect(stub.hasSubscriber()).toBe(true);

    stub.invokeSubscribe([{ cell: {}, tags: ["x"], userTags: [] }]);
    expect(seen).toEqual([[{ cell: {}, tags: ["x"], userTags: [] }]]);

    // A null delivery is normalized to an empty array.
    stub.invokeSubscribe(undefined);
    expect(seen[1]).toEqual([]);

    cancel();
    expect(stub.wasUnsubscribed()).toBe(true);
    // After cleanup, further deliveries are dropped.
    stub.invokeSubscribe([{ cell: {}, tags: ["y"], userTags: [] }]);
    expect(seen.length).toBe(2);
  });

  it("subscribeFavorites reports setup errors to onError", async () => {
    const stub = makeStub({ ensureThrows: true });
    const seen: unknown[] = [];
    let reported: Error | undefined;
    new FavoritesManager(stub.rt).subscribeFavorites(
      (f) => seen.push(f),
      (err) => {
        reported = err;
      },
    );
    await tick();
    await tick();
    expect(reported?.message).toBe("ensure failed");
    // The callback is still invoked once with an empty list on failure.
    expect(seen).toEqual([[]]);
  });

  it("subscribeFavorites treats a runtime-disposed error as cancellation", async () => {
    const stub = makeStub({ ensureDisposed: true });
    const seen: unknown[] = [];
    let reported: Error | undefined;
    new FavoritesManager(stub.rt).subscribeFavorites(
      (f) => seen.push(f),
      (err) => {
        reported = err;
      },
    );
    await tick();
    await tick();
    // A disposed runtime is an expected teardown race, not an error: neither
    // onError nor the empty-list callback fires.
    expect(reported).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("subscribeFavorites logs setup errors when no onError is given", async () => {
    const stub = makeStub({ ensureThrows: true });
    const original = console.error;
    let logged = false;
    console.error = () => {
      logged = true;
    };
    try {
      new FavoritesManager(stub.rt).subscribeFavorites(() => {});
      await tick();
      await tick();
    } finally {
      console.error = original;
    }
    expect(logged).toBe(true);
  });
});
