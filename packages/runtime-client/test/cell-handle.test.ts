import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import {
  linkRefFrom,
  linkRefPayloadFromString,
} from "@commonfabric/runner/shared";

import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  isCellHandle,
  RequestType,
  type RuntimeClient,
} from "@/mod.ts";
import { cellRefToIdentityKey, cellRefToKey } from "@/shared/utils.ts";

describe("cell-handle", () => {
  it("pulls lazy producers before caching the returned value", async () => {
    const requests: unknown[] = [];
    const ref: CellRef = {
      id: "of:lazy-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "session",
      path: [],
    };
    const runtime = {
      [$conn]: () => ({
        request: (request: unknown) => {
          requests.push(request);
          return Promise.resolve({ value: { ready: true } });
        },
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle<{ ready: boolean }>(runtime, ref);

    await expect(cell.pull()).resolves.toEqual({ ready: true });
    expect(cell.get()).toEqual({ ready: true });
    expect(requests).toEqual([{
      type: RequestType.CellPull,
      cell: ref,
    }]);
  });

  describe("SQLite IPC", () => {
    const ref: CellRef = {
      id: "of:database" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    it("queries through the database cell and hydrates returned cell refs", async () => {
      const requests: unknown[] = [];
      const linked = { ...ref, id: "of:linked" as CellRef["id"] };
      const runtime = {
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({
              rows: [{
                title: realmFromFabricValue("One"),
                source: realmFromFabricValue(linkRefFrom(linked)),
              }],
            });
          },
        }),
      } as unknown as RuntimeClient;
      const database = new CellHandle(runtime, ref);

      const rows = await database.querySqlite<{
        title: string;
        source: CellHandle<unknown>;
      }>("SELECT title, source FROM notes WHERE id = ?", [1]);

      expect(requests).toEqual([{
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT title, source FROM notes WHERE id = ?",
        params: {
          kind: "positional",
          values: [realmFromFabricValue(1)],
        },
      }]);
      expect(rows[0]?.title).toBe("One");
      expect(rows[0]?.source).toBeInstanceOf(CellHandle);
      expect(rows[0]?.source.ref()).toEqual(linked);
    });

    it("commits writes through the database cell", async () => {
      const requests: unknown[] = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({});
          },
        }),
      } as unknown as RuntimeClient;
      const database = new CellHandle(runtime, ref);

      await database.execSqlite(
        "INSERT INTO notes (title) VALUES (:title)",
        { title: "New" },
      );

      expect(requests).toEqual([{
        type: RequestType.SqliteExec,
        cell: ref,
        sql: "INSERT INTO notes (title) VALUES (:title)",
        params: {
          kind: "named",
          entries: [["title", realmFromFabricValue("New")]],
        },
      }]);
    });

    it("preserves BLOB values in query rows and bind parameters", async () => {
      const requests: unknown[] = [];
      const output = new FabricBytes(new Uint8Array([1, 2, 3]));
      const input = new FabricBytes(new Uint8Array([4, 5, 6]));
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType }) => {
            requests.push(structuredClone(request));
            return Promise.resolve(
              request.type === RequestType.SqliteQuery
                ? structuredClone({
                  rows: [{ payload: realmFromFabricValue(output) }],
                })
                : {},
            );
          },
        }),
      } as unknown as RuntimeClient;
      const database = new CellHandle(runtime, ref);

      const rows = await database.querySqlite<{ payload: FabricBytes }>(
        "SELECT payload FROM blobs",
      );
      await database.execSqlite(
        "INSERT INTO blobs (payload) VALUES (?)",
        [input],
      );

      expect(rows[0]?.payload).toBeInstanceOf(FabricBytes);
      expect(rows[0]?.payload.slice()).toEqual(new Uint8Array([1, 2, 3]));
      const request = requests[1] as {
        params: { kind: "positional"; values: [unknown] };
      };
      const parameter = fabricFromRealmValue(
        request.params.values[0] as RealmEncodedValue,
      );
      expect(parameter).toBeInstanceOf(FabricBytes);
      expect((parameter as FabricBytes).slice()).toEqual(
        new Uint8Array([4, 5, 6]),
      );
    });

    it("serializes linked and nested SQLite bind values", async () => {
      const requests: unknown[] = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(structuredClone(request));
            return Promise.resolve({});
          },
        }),
      } as unknown as RuntimeClient;
      const database = new CellHandle(runtime, ref);
      const linkedRef = { ...ref, id: "of:linked" as CellRef["id"] };
      const linked = new CellHandle(runtime, linkedRef);
      const bytes = new FabricBytes(new Uint8Array([7, 8, 9]));

      await database.execSqlite(
        "SELECT :linked, :nested",
        {
          linked,
          nested: { bytes, links: [linked] },
        },
      );

      const params = Object.fromEntries(
        (requests[0] as {
          params: {
            kind: "named";
            entries: Array<[string, RealmEncodedValue]>;
          };
        }).params.entries,
      );
      expect(fabricFromRealmValue(params.linked!)).toEqual(linkedRef);
      const nested = fabricFromRealmValue(params.nested!) as {
        bytes: FabricBytes;
        links: CellRef[];
      };
      expect(nested.bytes).toBeInstanceOf(FabricBytes);
      expect(nested.bytes.slice()).toEqual(new Uint8Array([7, 8, 9]));
      expect(nested.links).toEqual([linkedRef]);
    });

    it("rejects unsupported Fabric special objects in SQLite binds", async () => {
      const runtime = {
        [$conn]: () => ({ request: () => Promise.resolve({}) }),
      } as unknown as RuntimeClient;
      const database = new CellHandle(runtime, ref);

      await expect(database.execSqlite(
        "SELECT :nested",
        { nested: { when: new FabricEpochNsec(1n) } },
      )).rejects.toThrow(
        "SQLite bind values support `FabricBytes` but not `FabricEpochNsec`.",
      );
    });
  });

  describe("CellHandle CFC label IPC", () => {
    it("queries the runtime for the label view behind a cell", async () => {
      const cfcLabel = {
        version: 1 as const,
        entries: [{
          path: [],
          label: { confidentiality: ["prompt-risk"] },
        }],
      };
      const requests: unknown[] = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({ cfcLabel });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      } as unknown as RuntimeClient;
      const ref: CellRef = {
        id: "of:cfc-label-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
      };

      const cell = new CellHandle(runtime, ref);

      await expect(cell.getCfcLabel()).resolves.toEqual(cfcLabel);
      expect(requests).toEqual([{
        type: RequestType.CellGetCfcLabel,
        cell: ref,
      }]);
    });

    it("rebases ref-carried label views when creating child handles", async () => {
      const requests: unknown[] = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({ cfcLabel: undefined });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      } as unknown as RuntimeClient;
      const ref = {
        id: "of:cfc-label-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
        cfcLabelView: {
          version: 1 as const,
          entries: [{
            path: [],
            label: { integrity: ["selected-by-alice"] },
          }, {
            path: ["details"],
            label: { integrity: ["authored-by-bob"] },
          }],
        },
      } as CellRef;

      const child = new CellHandle<{ details: string }>(runtime, ref)
        .key("details");
      await child.getCfcLabel();

      expect(requests).toEqual([{
        type: RequestType.CellGetCfcLabel,
        cell: {
          id: ref.id,
          space: ref.space,
          scope: "space",
          path: ["details"],
          cfcLabelView: {
            version: 1,
            entries: [{
              path: [],
              label: {
                integrity: ["selected-by-alice", "authored-by-bob"],
              },
            }],
          },
        },
      }]);
    });

    // Inv-12 Stage 0: toJSON output is what JSON.stringify emits when a handle
    // lands in CustomEvent.detail (drag/drop sourceCell) — a raw sigil link
    // that re-enters the worker through the VDOM event path, bypassing
    // getCell/cellRefToSigilLink. The ref's display view must not ride it
    // (codex/cubic review on the Stage 0 PR); like toWireString, only
    // addressing fields (+schema) serialize.
    it("does not serialize the ref-carried label view into sigil links", () => {
      const runtime = {
        [$conn]: () => ({
          request: () => Promise.resolve({}),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, {
        id: "of:cfc-label-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: ["value"],
        cfcLabelView: {
          version: 1 as const,
          entries: [{
            path: [],
            label: { integrity: ["selected-by-alice"] },
          }],
        },
      } as CellRef);

      expect(cell.toJSON()).toEqual({
        "/": {
          "link@1": {
            id: "of:cfc-label-cell",
            space: "did:key:test",
            scope: "space",
            path: ["value"],
          },
        },
      });
    });

    it("encodes its link to an fcl1: wire string with only addressing fields", () => {
      const runtime = {
        [$conn]: () => ({
          request: () => Promise.resolve({}),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, {
        id: "of:wire-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: ["value"],
        // Neither of these may cross the wire.
        schema: { type: "object" },
        cfcLabelView: {
          version: 1 as const,
          entries: [{ path: [], label: { integrity: ["selected-by-alice"] } }],
        },
      } as CellRef);

      const wire = cell.toWireString();
      // It's the fcl1: cell-link form, not raw JSON.
      expect(wire.startsWith("fcl1:")).toBe(true);
      // ...and decodes back to only the plain addressing fields: `schema` and
      // `cfcLabelView` are dropped.
      expect(linkRefPayloadFromString(wire)).toEqual({
        id: "of:wire-cell",
        space: "did:key:test",
        scope: "space",
        path: ["value"],
      });
    });

    it("carries overwrite onto the wire when set", () => {
      const runtime = {
        [$conn]: () => ({
          request: () => Promise.resolve({}),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      } as unknown as RuntimeClient;
      // Exercises toWireString's `overwrite` conditional (the other tests leave
      // it unset).
      const cell = new CellHandle(runtime, {
        id: "of:wire-cell-2" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: ["value"],
        overwrite: "redirect",
      } as CellRef);

      expect(linkRefPayloadFromString(cell.toWireString())).toEqual({
        id: "of:wire-cell-2",
        space: "did:key:test",
        scope: "space",
        path: ["value"],
        overwrite: "redirect",
      });
    });

    it("uses carried label views in subscription keys", () => {
      const first: CellRef = {
        id: "of:cfc-label-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
        cfcLabelView: {
          version: 1 as const,
          entries: [{
            path: [],
            label: { integrity: ["selected-first"] },
          }],
        },
      };
      const second: CellRef = {
        ...first,
        cfcLabelView: {
          version: 1 as const,
          entries: [{
            path: [],
            label: { integrity: ["selected-second"] },
          }],
        },
      };

      expect(cellRefToKey(first)).not.toEqual(cellRefToKey(second));
    });

    it("keys on the full schemed id; id() strips of: only", () => {
      const runtime = {
        [$conn]: () => ({
          request: () => Promise.resolve({}),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      } as unknown as RuntimeClient;
      const refFor = (id: string): CellRef => ({
        id: id as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
      });

      // Keys carry the FULL schemed id: the hash preimage is kind-free, so
      // of:fid1:H and computed:fid1:H can be two distinct docs for one cause —
      // their subscriptions must not conflate.
      expect(cellRefToKey(refFor("of:fid1:abc"))).not.toEqual(
        cellRefToKey(refFor("computed:fid1:abc")),
      );
      expect(cellRefToKey(refFor("of:fid1:abc"))).not.toEqual(
        cellRefToKey(refFor("fid1:abc")),
      );

      // Scope is part of the address: equal space/id/path values in different
      // scopes refer to different documents and need independent subscriptions.
      expect(cellRefToKey(refFor("of:fid1:abc"))).not.toEqual(
        cellRefToKey({ ...refFor("of:fid1:abc"), scope: "user" }),
      );
      expect(
        cellRefToKey({ ...refFor("of:fid1:abc"), scope: "user" }),
      ).not.toEqual(
        cellRefToKey({ ...refFor("of:fid1:abc"), scope: "session" }),
      );

      // Paths are JSON-encoded in keys: a "." join would conflate ["."] with
      // ["", ""].
      const withPath = (path: string[]): CellRef => ({
        ...refFor("of:fid1:abc"),
        path,
      });
      expect(cellRefToKey(withPath(["."]))).not.toEqual(
        cellRefToKey(withPath(["", ""])),
      );

      // Operation ordering follows only the canonical address. Display schema
      // and labels can differ between handles without splitting their queue.
      const address = refFor("of:fid1:abc");
      expect(cellRefToIdentityKey({
        ...address,
        schema: { type: "string" },
      })).toEqual(cellRefToIdentityKey({
        ...address,
        schema: { type: "number" },
        cfcLabelView: { version: 1, entries: [] },
      }));
      expect(cellRefToIdentityKey(address)).not.toEqual(
        cellRefToIdentityKey({ ...address, scope: "user" }),
      );
      expect(cellRefToIdentityKey(withPath(["."]))).not.toEqual(
        cellRefToIdentityKey(withPath(["", ""])),
      );

      // CellHandle.id() is the FULL schemed id — a true identity accessor.
      // The routing/display strip lives on PageHandle.id().
      expect(new CellHandle(runtime, refFor("of:fid1:abc")).id())
        .toBe("of:fid1:abc");
      expect(new CellHandle(runtime, refFor("computed:fid1:abc")).id())
        .toBe("computed:fid1:abc");
      expect(new CellHandle(runtime, refFor("fid1:abc")).id()).toBe("fid1:abc");
    });

    it("refreshes reused cell refs when carried label views change", async () => {
      const requests: unknown[] = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({ cfcLabel: undefined });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      } as unknown as RuntimeClient;
      const baseRef: CellRef = {
        id: "of:cfc-label-parent" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
        schema: true,
      };
      const childRef = {
        id: "of:cfc-label-child",
        space: "did:key:test",
        scope: "space",
        path: [],
      };
      const firstLabel = {
        version: 1 as const,
        entries: [{
          path: [],
          label: { integrity: ["selected-first"] },
        }],
      };
      const secondLabel = {
        version: 1 as const,
        entries: [{
          path: [],
          label: { integrity: ["selected-second"] },
        }],
      };
      const linkWithLabel = (cfcLabelView: typeof firstLabel) => ({
        "/": {
          "link@1": {
            ...childRef,
            cfcLabelView,
          },
        },
      });

      const parent = new CellHandle<{ item: CellHandle }>(runtime, baseRef);
      parent[$onCellUpdate]({ item: linkWithLabel(firstLabel) });
      const firstChild = parent.get()!.item;
      await firstChild.getCfcLabel();

      parent[$onCellUpdate]({ item: linkWithLabel(secondLabel) });
      const secondChild = parent.get()!.item;
      await secondChild.getCfcLabel();

      expect(secondChild).not.toBe(firstChild);
      expect(requests).toEqual([{
        type: RequestType.CellGetCfcLabel,
        cell: {
          ...childRef,
          path: [],
          cfcLabelView: firstLabel,
        },
      }, {
        type: RequestType.CellGetCfcLabel,
        cell: {
          ...childRef,
          path: [],
          cfcLabelView: secondLabel,
        },
      }]);
    });
  });

  describe("CellHandle reactive CFC label delivery", () => {
    const makeRuntime = () =>
      ({
        [$conn]: () => ({
          request: () => Promise.resolve({ value: undefined }),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      }) as unknown as RuntimeClient;
    const ref: CellRef = {
      id: "of:reactive-label-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const labelA = {
      version: 1 as const,
      entries: [{ path: [], label: { integrity: ["authored-by-alice"] } }],
    };
    const labelB = {
      version: 1 as const,
      entries: [{ path: [], label: { integrity: ["authored-by-bob"] } }],
    };

    it("delivers the label and re-fires a label-aware subscriber on a label-only change", () => {
      const cell = new CellHandle<string>(makeRuntime(), ref);
      const calls: Array<[string | undefined, unknown]> = [];
      cell.subscribe((value, cfcLabel) => {
        calls.push([value, cfcLabel]);
      }, { includeCfcLabel: true });

      // Immediate call on subscribe with the current (empty) state.
      expect(calls).toEqual([[undefined, undefined]]);

      cell[$onCellUpdate]("v1", { cfcLabel: labelA });
      expect(calls.at(-1)).toEqual(["v1", labelA]);
      expect(cell.cfcLabel).toEqual(labelA);

      // Same VALUE, different LABEL → still fires (the reactivity that value
      // subscriptions miss).
      cell[$onCellUpdate]("v1", { cfcLabel: labelB });
      expect(calls.at(-1)).toEqual(["v1", labelB]);
      expect(cell.cfcLabel).toEqual(labelB);

      // Same value AND same label → deduped, no extra call.
      const before = calls.length;
      cell[$onCellUpdate]("v1", { cfcLabel: labelB });
      expect(calls.length).toBe(before);
    });

    it("does not fire a non-label subscriber on a label-only change", () => {
      const cell = new CellHandle<string>(makeRuntime(), ref);
      const calls: Array<string | undefined> = [];
      cell.subscribe((value) => {
        calls.push(value);
      }); // no includeCfcLabel

      expect(cell.wantsCfcLabel).toBe(false);
      cell[$onCellUpdate]("v1", { cfcLabel: labelA });
      const afterValue = calls.length; // fired once for the value change
      // Label-only change must be invisible to a value-only subscriber.
      cell[$onCellUpdate]("v1", { cfcLabel: labelB });
      expect(calls.length).toBe(afterValue);
    });

    it("leaves the cached label untouched on a value-only update", () => {
      const cell = new CellHandle<string>(makeRuntime(), ref);
      cell.subscribe(() => {}, { includeCfcLabel: true });
      cell[$onCellUpdate]("v1", { cfcLabel: labelA });
      expect(cell.cfcLabel).toEqual(labelA);
      // No `labelUpdate` arg = value-only update; label stays.
      cell[$onCellUpdate]("v2");
      expect(cell.get()).toBe("v2");
      expect(cell.cfcLabel).toEqual(labelA);
    });

    it("re-establishes the backend subscription when a label-aware subscriber is added later", async () => {
      const events: string[] = [];
      const runtime = {
        [$conn]: () => ({
          request: () => Promise.resolve({ value: undefined }),
          subscribe: () => {
            events.push("subscribe");
            return Promise.resolve();
          },
          unsubscribe: () => {
            events.push("unsubscribe");
            return Promise.resolve();
          },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<string>(runtime, ref);

      cell.subscribe(() => {}); // value-only first
      expect(cell.wantsCfcLabel).toBe(false);
      expect(events).toEqual(["subscribe"]);

      // A label-aware subscription on the SAME handle re-opens the backend sub so
      // it carries labels (the old one was label-less and would be deduped away).
      cell.subscribe(() => {}, { includeCfcLabel: true });
      expect(cell.wantsCfcLabel).toBe(true);
      await Promise.resolve(); // let the unsubscribe().finally(subscribe) settle
      expect(events).toEqual(["subscribe", "unsubscribe", "subscribe"]);
    });
  });

  describe("CellHandle $alias records stay plain data", () => {
    // `$alias` records are Pattern-binding vocabulary, only meaningful inside
    // Pattern objects the client never interprets. In data they are inert plain
    // values: hydration must not turn them into CellHandles (PR #4895).
    const makeRuntime = () =>
      ({
        [$conn]: () => ({
          request: () => Promise.resolve({}),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      }) as unknown as RuntimeClient;
    const ref: CellRef = {
      id: "of:alias-plain-data-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    // A genuine sigil link in the same payload — the positive control that the
    // hydration path is actually exercised.
    const sigilLink = {
      "/": {
        "link@1": {
          id: "of:linked-cell",
          space: "did:key:test",
          scope: "space",
          path: ["item"],
        },
      },
    };
    const payload = {
      binding: { $alias: { path: ["foo"] } },
      nested: { deeper: { $alias: { path: ["foo", "bar"] } } },
      link: sigilLink,
    };

    it("deserialize keeps $alias records plain while sigil links hydrate", () => {
      const base = new CellHandle(makeRuntime(), ref);

      const result = CellHandle.deserialize(base, payload) as Record<
        string,
        unknown
      >;

      // Positive control: the sigil link DOES become a CellHandle.
      expect(isCellHandle(result.link)).toBe(true);
      // The $alias records do not — they stay deep-equal plain data, at the top
      // level and nested.
      expect(isCellHandle(result.binding)).toBe(false);
      expect(result.binding).toEqual({ $alias: { path: ["foo"] } });
      expect(result.nested).toEqual({
        deeper: { $alias: { path: ["foo", "bar"] } },
      });
    });

    it("update delivery keeps $alias records plain while sigil links hydrate", () => {
      const cell = new CellHandle<{
        binding: unknown;
        nested: unknown;
        link: unknown;
      }>(makeRuntime(), ref);

      cell[$onCellUpdate](payload);
      const value = cell.get()!;

      // Positive control: the sigil link DOES become a CellHandle.
      expect(isCellHandle(value.link)).toBe(true);
      // The $alias records remain inert plain data.
      expect(isCellHandle(value.binding)).toBe(false);
      expect(value.binding).toEqual({ $alias: { path: ["foo"] } });
      expect(value.nested).toEqual({
        deeper: { $alias: { path: ["foo", "bar"] } },
      });
    });
  });

  describe("CellHandle update change detection", () => {
    const makeRuntime = () =>
      ({
        [$conn]: () => ({
          request: () => Promise.resolve({ value: undefined }),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      }) as unknown as RuntimeClient;
    const ref: CellRef = {
      id: "of:change-detection-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    it("does not re-notify on an unchanged NaN value", () => {
      // Value equality is `Object.is`-based: `NaN` equals itself, so a
      // delivery repeating a NaN-bearing value is not a change.
      const cell = new CellHandle<number>(makeRuntime(), ref);
      const calls: Array<number | undefined> = [];
      cell.subscribe((value) => {
        calls.push(value);
      });

      cell[$onCellUpdate](NaN);
      const after = calls.length;
      cell[$onCellUpdate](NaN);
      expect(calls.length).toBe(after);
    });

    it("does not re-notify on an unchanged NaN-bearing record", () => {
      const cell = new CellHandle<{ x: number }>(makeRuntime(), ref);
      const calls: Array<unknown> = [];
      cell.subscribe((value) => {
        calls.push(value);
      });

      cell[$onCellUpdate]({ x: NaN });
      const after = calls.length;
      cell[$onCellUpdate]({ x: NaN });
      expect(calls.length).toBe(after);
    });

    it("notifies when a special object's contents change", () => {
      // Two `FabricBytes` over different bytes are different values, and their
      // state is private -- so a walk over enumerable own properties sees `{}`
      // on both sides and would call them equal.
      const cell = new CellHandle<FabricBytes>(makeRuntime(), ref);
      const calls: Array<unknown> = [];
      cell.subscribe((value) => {
        calls.push(value);
      });

      cell[$onCellUpdate](new FabricBytes(new Uint8Array([1])));
      const after = calls.length;
      cell[$onCellUpdate](new FabricBytes(new Uint8Array([2])));

      expect(calls.length).toBe(after + 1);
    });

    it("refuses a `FabricInstance` rather than apply one", () => {
      // A tripwire: nothing delivers an instance today, the transport
      // stripping a fabric class before it arrives. This is `applyValue()`'s
      // refusal -- it runs first, which is why the comparison after it needs
      // no arm of its own.
      const cell = new CellHandle<unknown>(makeRuntime(), ref);
      cell.subscribe(() => {});
      const link = new FabricLink(
        Object.freeze({ id: "of:fid1:refusal", path: [] }),
      );

      expect(() => cell[$onCellUpdate](link)).toThrow(
        "Cannot yet handle `FabricLink` (a `FabricInstance`)",
      );
    });

    it("notifies when a handle is replaced by a record", () => {
      // A handle holds its state privately, so a walk over enumerable own
      // properties reads `{}` off it -- equal to any other key-less object,
      // `{}` included, which would drop the update and tell no subscriber.
      const cell = new CellHandle<{ a: unknown }>(makeRuntime(), ref);
      const calls: Array<unknown> = [];
      cell.subscribe((value) => {
        calls.push(value);
      });
      const inner = new CellHandle(makeRuntime(), {
        ...ref,
        id: "of:other-cell" as CellRef["id"],
      });

      cell[$onCellUpdate]({ a: inner });
      const after = calls.length;
      cell[$onCellUpdate]({ a: {} });

      expect(calls.length).toBe(after + 1);
    });

    it("notifies on a 0 -> -0 change", () => {
      // `0` and `-0` are distinct stored values (the content hash
      // distinguishes them); the update must not be dropped.
      const cell = new CellHandle<number>(makeRuntime(), ref);
      const calls: Array<number | undefined> = [];
      cell.subscribe((value) => {
        calls.push(value);
      });

      cell[$onCellUpdate](0);
      cell[$onCellUpdate](-0);
      expect(Object.is(calls.at(-1), -0)).toBe(true);
    });

    it("notifies when a linked cell changes scope", () => {
      const cell = new CellHandle<unknown>(makeRuntime(), ref);
      const calls: CellHandle[] = [];
      cell.subscribe((value) => {
        if (isCellHandle(value)) calls.push(value);
      });
      const link = (scope: "space" | "user") => ({
        "/": {
          "link@1": {
            id: "of:scoped-target",
            space: "did:key:test",
            scope,
            path: [],
          },
        },
      });

      cell[$onCellUpdate](link("space"));
      const spaceTarget = cell.get();
      cell[$onCellUpdate](link("user"));
      const userTarget = cell.get();

      expect(isCellHandle(spaceTarget)).toBe(true);
      expect(isCellHandle(userTarget)).toBe(true);
      expect(userTarget).not.toBe(spaceTarget);
      expect((userTarget as CellHandle).ref().scope).toBe("user");
      expect(calls).toHaveLength(2);
    });

    it("treats omitted scope as the default space scope", () => {
      const runtime = makeRuntime();
      const unscoped = new CellHandle(runtime, {
        ...ref,
        scope: undefined,
      } as unknown as CellRef);
      const spaceScoped = new CellHandle(runtime, ref);

      expect(unscoped.equals(spaceScoped)).toBe(true);
      expect(spaceScoped.equals(unscoped)).toBe(true);
    });
  });

  describe("CellHandle disposal-raced writes", () => {
    const ref: CellRef = {
      id: "of:write-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    // A connection whose request always rejects (as it does for an in-flight
    // write settled by disposal), reporting `aborted` per the test.
    function runtimeWith(aborted: boolean): RuntimeClient {
      return {
        [$conn]: () => ({
          request: () =>
            Promise.reject(new DOMException("aborted", "AbortError")),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted },
        }),
      } as unknown as RuntimeClient;
    }

    function captureError(): { calls: unknown[][]; restore(): void } {
      const calls: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => calls.push(args);
      return { calls, restore: () => (console.error = original) };
    }

    it("logs a send() failure while the connection is alive", async () => {
      const cell = new CellHandle(runtimeWith(false), ref);
      const spy = captureError();
      try {
        await cell.send({ n: 1 });
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(1);
    });

    it("suppresses send() logging when the connection is aborted", async () => {
      const cell = new CellHandle(runtimeWith(true), ref);
      const spy = captureError();
      try {
        await cell.send({ n: 1 });
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(0);
    });

    it("rejects a strict send when the runtime refuses the event", async () => {
      const cell = new CellHandle(runtimeWith(false), ref);

      await expect(cell.sendStrict({ n: 1 })).rejects.toThrow("aborted");
    });

    it("logs a set() failure while the connection is alive", async () => {
      const cell = new CellHandle(runtimeWith(false), ref);
      const spy = captureError();
      try {
        await cell.set({ n: 1 });
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(1);
    });

    it("suppresses set() logging when the connection is aborted", async () => {
      const cell = new CellHandle(runtimeWith(true), ref);
      const spy = captureError();
      try {
        await cell.set({ n: 1 });
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(0);
    });

    it("rejects a strict set when the runtime refuses the write", async () => {
      const cell = new CellHandle(runtimeWith(false), ref, { n: 0 });
      const updates: unknown[] = [];
      const unsubscribe = cell.subscribe((value) => {
        updates.push(value);
      });
      updates.length = 0;

      await expect(cell.setStrict({ n: 1 })).rejects.toThrow("aborted");
      expect(cell.get()).toEqual({ n: 0 });
      expect(updates).toEqual([]);
      unsubscribe();
    });

    it("keeps an earlier strict commit when a queued strict set fails", async () => {
      let writes = 0;
      const runtime = {
        [$conn]: () => ({
          request: () =>
            ++writes === 1
              ? Promise.resolve({})
              : Promise.reject(new Error("aborted")),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });

      const first = cell.setStrict({ n: 1 });
      const second = cell.setStrict({ n: 2 });

      await first;
      await expect(second).rejects.toThrow("aborted");
      expect(cell.get()).toEqual({ n: 1 });
    });

    it("publishes the strict value captured at invocation", async () => {
      const response = Promise.withResolvers<unknown>();
      let request: { value?: unknown } | undefined;
      const runtime = {
        [$conn]: () => ({
          request: (next: { value?: unknown }) => {
            request = structuredClone(next);
            return response.promise;
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });
      const value = { n: 1 };

      const writing = cell.setStrict(value);
      value.n = 2;
      response.resolve({});
      await writing;

      expect(request?.value).toEqual({ n: 1 });
      expect(cell.get()).toEqual({ n: 1 });
    });

    it("preserves nested cell handles in snapshotted sets", async () => {
      const requests: Array<{ value?: unknown }> = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: { value?: unknown }) => {
            requests.push(request);
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const linked = new CellHandle(runtime, {
        ...ref,
        id: "of:linked" as CellRef["id"],
      });
      const cell = new CellHandle<{ linked: CellHandle }>(runtime, ref);

      await cell.set({ linked });

      expect(cell.get()?.linked).toBe(linked);
      expect(requests[0].value).toEqual({ linked: linked.ref() });
    });

    it("marks strict writes as commit-confirmed requests", async () => {
      const requests: unknown[] = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });
      const updates: unknown[] = [];
      const unsubscribe = cell.subscribe((value) => {
        updates.push(value);
      });
      updates.length = 0;

      await cell.setStrict({ n: 1 });
      await cell.sendStrict({ n: 2 });

      expect(requests).toEqual([{
        type: RequestType.CellSet,
        cell: ref,
        value: { n: 1 },
        awaitCommit: true,
      }, {
        type: RequestType.CellSend,
        cell: ref,
        event: { n: 2 },
        awaitCommit: true,
      }]);
      expect(cell.get()).toEqual({ n: 1 });
      expect(updates).toEqual([{ n: 1 }]);
      unsubscribe();
    });

    it("preserves an equal authoritative update over a strict response", async () => {
      const response = Promise.withResolvers<unknown>();
      const runtime = {
        [$conn]: () => ({
          request: () => response.promise,
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 1 });

      const writing = cell.setStrict({ n: 2 });
      cell[$onCellUpdate]({ n: 1 });
      response.resolve({});
      await writing;

      expect(cell.get()).toEqual({ n: 1 });
    });

    it("waits for every queued strict write before a later read", async () => {
      const requests: RequestType[] = [];
      const firstWrite = Promise.withResolvers<void>();
      let stored = { n: 0 };
      let writes = 0;
      const runtime = {
        [$conn]: () => ({
          request: (request: {
            type: RequestType;
            value?: { n: number };
          }) => {
            requests.push(request.type);
            if (request.type === RequestType.CellSet) {
              writes++;
              const commit = () => {
                stored = request.value!;
                return {};
              };
              return writes === 1
                ? firstWrite.promise.then(commit)
                : Promise.resolve(commit());
            }
            return Promise.resolve({ value: stored });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });

      const first = cell.setStrict({ n: 1 });
      const second = cell.setStrict({ n: 2 });
      const reading = cell.sync();
      await Promise.resolve();
      expect(requests).toEqual([RequestType.CellSet]);

      firstWrite.resolve();
      await expect(reading).resolves.toEqual({ n: 2 });
      await Promise.all([first, second]);
      expect(requests).toEqual([
        RequestType.CellSet,
        RequestType.CellSet,
        RequestType.CellGet,
      ]);
    });

    it("waits for every queued strict event before later operations", async () => {
      const requests: RequestType[] = [];
      const firstEvent = Promise.withResolvers<void>();
      let events = 0;
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType }) => {
            requests.push(request.type);
            if (request.type === RequestType.CellSend && ++events === 1) {
              return firstEvent.promise.then(() => ({}));
            }
            if (request.type === RequestType.CellGet) {
              return Promise.resolve({ value: { n: 3 } });
            }
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });

      const first = cell.sendStrict({ n: 1 });
      const second = cell.sendStrict({ n: 2 });
      const setting = cell.set({ n: 3 });
      const reading = cell.sync();
      await Promise.resolve();
      expect(requests).toEqual([RequestType.CellSend]);

      firstEvent.resolve();
      await Promise.all([first, second, setting, reading]);
      expect(requests).toEqual([
        RequestType.CellSend,
        RequestType.CellSend,
        RequestType.CellSet,
        RequestType.CellGet,
      ]);
    });

    it("publishes optimistic sets immediately while their requests stay queued", async () => {
      const firstWrite = Promise.withResolvers<void>();
      const requests: Array<{ type: RequestType; value?: { n: number } }> = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: {
            type: RequestType;
            value?: { n: number };
          }) => {
            requests.push(request);
            return requests.length === 1
              ? firstWrite.promise.then(() => ({}))
              : Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });
      const updates: Array<{ n: number } | undefined> = [];
      const cancel = cell.subscribe((value) => {
        updates.push(value);
      });
      updates.length = 0;

      const first = cell.set({ n: 1 });
      const second = cell.set({ n: 2 });
      const third = cell.set({ n: 3 });

      expect(updates).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      expect(cell.get()).toEqual({ n: 3 });
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.CellSet,
      ]);

      firstWrite.resolve();
      await Promise.all([first, second, third]);
      expect(requests.map(({ value }) => value)).toEqual([
        { n: 1 },
        { n: 2 },
        { n: 3 },
      ]);
      cancel();
    });

    it("keeps a later optimistic set over an earlier read response", async () => {
      const readResponse = Promise.withResolvers<{
        value: { n: number };
      }>();
      const requests: RequestType[] = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType }) => {
            requests.push(request.type);
            return request.type === RequestType.CellGet
              ? readResponse.promise
              : Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });

      const reading = cell.sync();
      const setting = cell.set({ n: 2 });
      expect(cell.get()).toEqual({ n: 2 });
      expect(requests).toEqual([RequestType.CellGet]);

      readResponse.resolve({ value: { n: 0 } });
      await expect(reading).resolves.toEqual({ n: 0 });
      await setting;
      expect(requests).toEqual([
        RequestType.CellGet,
        RequestType.CellSet,
      ]);
      expect(cell.get()).toEqual({ n: 2 });
    });

    it("preserves authoritative updates over sync and pull responses", async () => {
      const verify = async (operation: "sync" | "pull") => {
        const response = Promise.withResolvers<{ value: { n: number } }>();
        const runtime = {
          [$conn]: () => ({
            request: () => response.promise,
            subscribe: () => Promise.resolve(),
            unsubscribe: () => Promise.resolve(),
            signal: { aborted: false },
          }),
        } as unknown as RuntimeClient;
        const cell = new CellHandle(runtime, ref, { n: 0 });

        const reading = cell[operation]();
        cell[$onCellUpdate]({ n: 1 });
        response.resolve({ value: { n: 0 } });

        await expect(reading).resolves.toEqual({ n: 0 });
        expect(cell.get()).toEqual({ n: 1 });
      };

      await verify("sync");
      await verify("pull");
    });

    it("keeps a queued read ahead of a later strict write", async () => {
      const firstWrite = Promise.withResolvers<void>();
      const readResponse = Promise.withResolvers<void>();
      const readStarted = Promise.withResolvers<void>();
      const requests: RequestType[] = [];
      let stored = { n: 0 };
      let writes = 0;
      const runtime = {
        [$conn]: () => ({
          request: (request: {
            type: RequestType;
            value?: { n: number };
          }) => {
            requests.push(request.type);
            if (request.type === RequestType.CellSet) {
              const commit = () => {
                stored = request.value!;
                return {};
              };
              return ++writes === 1
                ? firstWrite.promise.then(commit)
                : Promise.resolve(commit());
            }
            const captured = stored;
            readStarted.resolve();
            return readResponse.promise.then(() => ({ value: captured }));
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, stored);

      const first = cell.setStrict({ n: 1 });
      const reading = cell.sync();
      const second = cell.setStrict({ n: 2 });
      expect(requests).toEqual([RequestType.CellSet]);

      firstWrite.resolve();
      await readStarted.promise;
      expect(requests).toEqual([
        RequestType.CellSet,
        RequestType.CellGet,
      ]);

      readResponse.resolve();
      await Promise.all([first, reading, second]);
      expect(requests).toEqual([
        RequestType.CellSet,
        RequestType.CellGet,
        RequestType.CellSet,
      ]);
      expect(cell.get()).toEqual({ n: 2 });
    });

    it("shares operation order across equivalent handles", async () => {
      const writeResponse = Promise.withResolvers<void>();
      const requests: RequestType[] = [];
      const connection = {
        request: (request: { type: RequestType }) => {
          requests.push(request.type);
          return request.type === RequestType.CellSet
            ? writeResponse.promise.then(() => ({}))
            : Promise.resolve({ value: { n: 1 } });
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      };
      const runtime = {
        [$conn]: () => connection,
      } as unknown as RuntimeClient;
      const first = new CellHandle(runtime, {
        ...ref,
        schema: { type: "object" },
      }, { n: 0 });
      const second = new CellHandle(runtime, {
        ...ref,
        schema: {
          type: "object",
          properties: { n: { type: "number" } },
        },
      }, { n: 0 });

      const writing = first.setStrict({ n: 1 });
      const reading = second.sync();
      expect(requests).toEqual([RequestType.CellSet]);

      writeResponse.resolve();
      await Promise.all([writing, reading]);
      expect(requests).toEqual([
        RequestType.CellSet,
        RequestType.CellGet,
      ]);
    });

    it("waits for every queued strict write before later remote operations", async () => {
      const requests: RequestType[] = [];
      const firstWrite = Promise.withResolvers<void>();
      let writes = 0;
      const resolvedRef = {
        ...ref,
        id: "of:strict-resolved" as CellRef["id"],
      };
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType }) => {
            requests.push(request.type);
            if (request.type === RequestType.CellSet) {
              writes++;
              return writes === 1
                ? firstWrite.promise.then(() => ({}))
                : Promise.resolve({});
            }
            switch (request.type) {
              case RequestType.CellResolveAsCell:
                return Promise.resolve({ cell: resolvedRef });
              case RequestType.CellGetCfcLabel:
                return Promise.resolve({ cfcLabel: undefined });
              case RequestType.SqliteQuery:
                return Promise.resolve({ rows: [] });
              default:
                return Promise.resolve({});
            }
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });

      const first = cell.setStrict({ n: 1 });
      const second = cell.setStrict({ n: 2 });
      const later = [
        cell.set({ n: 3 }),
        cell.send({ n: 4 }),
        cell.resolveAsCell(),
        cell.getCfcLabel(),
        cell.querySqlite("SELECT 1"),
        cell.execSqlite("DELETE FROM notes"),
      ];
      await Promise.resolve();
      expect(requests).toEqual([RequestType.CellSet]);

      firstWrite.resolve();
      await Promise.all([first, second, ...later]);
      expect(requests).toEqual([
        RequestType.CellSet,
        RequestType.CellSet,
        RequestType.CellSet,
        RequestType.CellSend,
        RequestType.CellResolveAsCell,
        RequestType.CellGetCfcLabel,
        RequestType.SqliteQuery,
        RequestType.SqliteExec,
      ]);
    });

    it("snapshots queued event and SQLite arguments at invocation", async () => {
      const firstWrite = Promise.withResolvers<void>();
      const requests: Array<Record<string, unknown>> = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: Record<string, unknown>) => {
            requests.push(structuredClone(request));
            if (request.type === RequestType.CellSet) {
              return firstWrite.promise.then(() => ({}));
            }
            if (request.type === RequestType.SqliteQuery) {
              return Promise.resolve({ rows: [] });
            }
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, ref, { n: 0 });
      const event = { n: 1 };
      const queryParams = { payload: { n: 1 } };
      const execParams = [{ n: 1 }];

      const first = cell.setStrict({ n: 1 });
      const sending = cell.send(event);
      const querying = cell.querySqlite("SELECT :payload", queryParams);
      const executing = cell.execSqlite("DELETE FROM notes WHERE value = ?", {
        payload: execParams,
      });
      event.n = 2;
      queryParams.payload.n = 2;
      execParams[0].n = 2;

      firstWrite.resolve();
      await Promise.all([first, sending, querying, executing]);

      expect(requests.find(({ type }) => type === RequestType.CellSend)?.event)
        .toEqual({ n: 1 });
      for (const type of [RequestType.SqliteQuery, RequestType.SqliteExec]) {
        const params = requests.find((request) => request.type === type)
          ?.params as {
            entries: Array<[string, RealmEncodedValue]>;
          };
        expect(fabricFromRealmValue(params.entries[0][1])).toEqual(
          type === RequestType.SqliteQuery ? { n: 1 } : [{ n: 1 }],
        );
      }
    });
  });

  describe("CellHandle push", () => {
    const ref: CellRef = {
      id: "of:push-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    const runtimeCapturing = (requests: unknown[]): RuntimeClient =>
      ({
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      }) as unknown as RuntimeClient;

    it("sends a CellPush carrying only the appended members", () => {
      const requests: unknown[] = [];
      const cell = new CellHandle<number[]>(runtimeCapturing(requests), ref);
      // Seed the local cache so push has an array to read-modify-write.
      cell[$onCellUpdate]([1, 2]);

      cell.push(3);

      expect(requests.length).toBe(1);
      const request = requests[0] as { type: unknown; values: unknown };
      expect(request.type).toBe(RequestType.CellPush);
      expect(request.values).toEqual([3]);
      expect(request).toMatchObject({ awaitCommit: true });
      expect(cell.get()).toEqual([1, 2, 3]);
    });

    it("reports a refused strict push to capability callers", async () => {
      const refused = new Error("push refused");
      const runtime = {
        [$conn]: () => ({
          request: () => Promise.reject(refused),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [1]);

      await expect(cell.pushStrict(2)).rejects.toBe(refused);
      expect(cell.get()).toEqual([1]);
    });

    it("throws when the cell is not an array", () => {
      const cell = new CellHandle<number[]>(runtimeCapturing([]), ref);
      cell[$onCellUpdate]("not an array" as unknown as number[]);
      expect(() => cell.push(1)).toThrow(
        "push() can only be used on array cells",
      );
    });

    it("appends after queued strict writes", async () => {
      const firstWrite = Promise.withResolvers<void>();
      const requests: Array<{
        type: RequestType;
        value?: unknown;
        values?: unknown[];
      }> = [];
      let writes = 0;
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType; value?: unknown }) => {
            requests.push(request);
            if (request.type === RequestType.CellSet && ++writes === 1) {
              return firstWrite.promise.then(() => ({}));
            }
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [0]);

      const first = cell.setStrict([1]);
      const second = cell.setStrict([2]);
      cell.push(3);
      await Promise.resolve();
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.CellSet,
      ]);

      firstWrite.resolve();
      await Promise.all([first, second]);
      await Promise.resolve();
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.CellSet,
        RequestType.CellSet,
        RequestType.CellPush,
      ]);
      expect(requests.at(-1)?.values).toEqual([3]);
    });

    it("keeps strict replacements in the shared append queue", async () => {
      const requests: RequestType[] = [];
      let stored = [0];
      const runtime = {
        [$conn]: () => ({
          request: (request: {
            type: RequestType;
            value?: unknown;
            values?: unknown[];
          }) => {
            requests.push(request.type);
            if (request.type === RequestType.CellSet) {
              stored = request.value as number[];
            } else if (request.type === RequestType.CellPush) {
              stored = [...stored, ...request.values as number[]];
            }
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [0]);
      const published: Array<readonly number[] | undefined> = [];
      cell.subscribe((value) => {
        published.push(value);
      });

      cell.push(1);
      const replacing = cell.setStrict([9]);
      cell.push(2);
      const drained = cell.sendStrict([]);
      await Promise.all([replacing, drained]);

      expect(requests).toEqual([
        RequestType.CellPush,
        RequestType.CellSet,
        RequestType.CellPush,
        RequestType.CellSend,
      ]);
      expect(stored).toEqual([9, 2]);
      expect(cell.get()).toEqual([9, 2]);
      expect(published.at(-1)).toEqual([9, 2]);
    });

    it("appends to a queued replacement from an equivalent handle", async () => {
      const requests: Array<{
        type: RequestType;
        value?: unknown;
        values?: unknown[];
      }> = [];
      let stored = [0];
      const runtime = {
        [$conn]: () => ({
          request: (
            request: {
              type: RequestType;
              value?: unknown;
              values?: unknown[];
            },
          ) => {
            requests.push(request);
            if (request.type === RequestType.CellSet) {
              stored = request.value as number[];
              return Promise.resolve({});
            }
            if (request.type === RequestType.CellPush) {
              stored = [...stored, ...request.values as number[]];
              return Promise.resolve({});
            }
            return Promise.resolve({ value: stored });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const first = new CellHandle<number[]>(runtime, ref, [0]);
      const second = new CellHandle<number[]>(runtime, {
        ...ref,
        schema: { type: "array" },
      }, [0]);

      const replacing = first.setStrict([1]);
      second.push(2);
      await replacing;
      await second.sync();

      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.CellSet,
        RequestType.CellPush,
        RequestType.CellGet,
      ]);
      expect(stored).toEqual([1, 2]);
      expect(second.get()).toEqual([1, 2]);
    });

    it("appends to a committed replacement from an equivalent handle", async () => {
      const requests: Array<{
        type: RequestType;
        value?: unknown;
        values?: unknown[];
      }> = [];
      let stored = [0];
      const runtime = {
        [$conn]: () => ({
          request: (
            request: {
              type: RequestType;
              value?: unknown;
              values?: unknown[];
            },
          ) => {
            requests.push(request);
            if (request.type === RequestType.CellSet) {
              stored = request.value as number[];
              return Promise.resolve({});
            }
            if (request.type === RequestType.CellPush) {
              stored = [...stored, ...request.values as number[]];
              return Promise.resolve({});
            }
            return Promise.resolve({ value: stored });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const first = new CellHandle<number[]>(runtime, ref, [0]);
      const second = new CellHandle<number[]>(runtime, {
        ...ref,
        schema: { type: "array" },
      }, [0]);

      await first.setStrict([1]);
      await Promise.resolve();
      second.push(2);
      await second.sync();

      expect(stored).toEqual([1, 2]);
      expect(second.get()).toEqual([1, 2]);
    });

    it("preserves an equivalent handle update across a strict response", async () => {
      const strictResponse = Promise.withResolvers<void>();
      let stored = [0];
      const runtime = {
        [$conn]: () => ({
          request: (
            request: {
              type: RequestType;
              value?: unknown;
              values?: unknown[];
            },
          ) => {
            if (request.type === RequestType.CellSet) {
              stored = request.value as number[];
              return strictResponse.promise.then(() => ({}));
            }
            if (request.type === RequestType.CellPush) {
              stored = [...stored, ...request.values as number[]];
            }
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const first = new CellHandle<number[]>(runtime, ref, [0]);
      const second = new CellHandle<number[]>(runtime, {
        ...ref,
        schema: { type: "array" },
      }, [0]);

      const replacing = first.setStrict([9]);
      stored = [7];
      second[$onCellUpdate]([7]);
      second.push(2);

      strictResponse.resolve();
      await replacing;
      await second.sendStrict([]);

      expect(stored).toEqual([7, 2]);
      expect(first.get()).toEqual([0]);
      expect(second.get()).toEqual([7, 2]);
    });

    it("does not append to a later optimistic replacement", async () => {
      const firstWrite = Promise.withResolvers<void>();
      const requests: Array<{
        type: RequestType;
        value?: unknown;
        values?: unknown[];
      }> = [];
      let stored = [0];
      let writes = 0;
      const runtime = {
        [$conn]: () => ({
          request: (
            request: {
              type: RequestType;
              value?: unknown;
              values?: unknown[];
            },
          ) => {
            requests.push(request);
            if (
              request.type === RequestType.CellSet ||
              request.type === RequestType.CellPush
            ) {
              const commit = () => {
                stored = request.type === RequestType.CellSet
                  ? request.value as number[]
                  : [...stored, ...request.values as number[]];
                return {};
              };
              return ++writes === 1
                ? firstWrite.promise.then(commit)
                : Promise.resolve(commit());
            }
            return Promise.resolve({ value: stored });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [0]);

      const replacing = cell.setStrict([1]);
      cell.push(2);
      const later = cell.set([3]);
      expect(cell.get()).toEqual([3]);

      firstWrite.resolve();
      await Promise.all([replacing, later]);
      await cell.sync();

      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.CellSet,
        RequestType.CellPush,
        RequestType.CellSet,
        RequestType.CellGet,
      ]);
      expect(requests[1].values).toEqual([2]);
      expect(stored).toEqual([3]);
    });

    it("keeps a later mutation newer than a delayed append", async () => {
      for (const strict of [false, true]) {
        const firstEvent = Promise.withResolvers<void>();
        let stored = [0];
        const runtime = {
          [$conn]: () => ({
            request: (request: {
              type: RequestType;
              value?: unknown;
              values?: unknown[];
            }) => {
              if (request.type === RequestType.CellSend) {
                return firstEvent.promise.then(() => ({}));
              }
              if (request.type === RequestType.CellPush) {
                stored = [...stored, ...request.values as number[]];
              } else if (request.type === RequestType.CellSet) {
                stored = request.value as number[];
              }
              return Promise.resolve({});
            },
            subscribe: () => Promise.resolve(),
            unsubscribe: () => Promise.resolve(),
            signal: { aborted: false },
          }),
        } as unknown as RuntimeClient;
        const cell = new CellHandle<number[]>(runtime, ref, [0]);

        const blocking = cell.sendStrict([]);
        cell.push(1);
        const replacing = strict ? cell.setStrict([9]) : cell.set([9]);
        expect(cell.get()).toEqual(strict ? [0] : [9]);

        firstEvent.resolve();
        await Promise.all([blocking, replacing]);

        expect(stored).toEqual([9]);
        expect(cell.get()).toEqual([9]);
      }
    });

    it("publishes a read invoked after a delayed append", async () => {
      const firstEvent = Promise.withResolvers<void>();
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType }) => {
            if (request.type === RequestType.CellSend) {
              return firstEvent.promise.then(() => ({}));
            }
            if (request.type === RequestType.CellGet) {
              return Promise.resolve({ value: [0, 8, 1] });
            }
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [0]);

      const blocking = cell.sendStrict([]);
      cell.push(1);
      const reading = cell.sync();

      firstEvent.resolve();
      expect(await reading).toEqual([0, 8, 1]);
      expect(cell.get()).toEqual([0, 8, 1]);
      await blocking;
    });

    it("appends values captured at invocation", async () => {
      const firstWrite = Promise.withResolvers<void>();
      const requests: Array<{
        type: RequestType;
        value?: unknown;
        values?: unknown[];
      }> = [];
      let stored: Array<{ n: number }> = [];
      let writes = 0;
      const runtime = {
        [$conn]: () => ({
          request: (request: {
            type: RequestType;
            value?: unknown;
            values?: unknown[];
          }) => {
            requests.push(structuredClone(request));
            if (
              request.type === RequestType.CellSet ||
              request.type === RequestType.CellPush
            ) {
              const commit = () => {
                stored = request.type === RequestType.CellSet
                  ? request.value as Array<{ n: number }>
                  : [
                    ...stored,
                    ...request.values as Array<{ n: number }>,
                  ];
                return {};
              };
              return ++writes === 1
                ? firstWrite.promise.then(commit)
                : Promise.resolve(commit());
            }
            return Promise.resolve({ value: stored });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<Array<{ n: number }>>(runtime, ref, []);
      const member = { n: 1 };

      const replacing = cell.setStrict([]);
      cell.push(member);
      member.n = 2;

      firstWrite.resolve();
      await replacing;
      await cell.sync();

      expect(requests.find(({ type }) => type === RequestType.CellPush)?.values)
        .toEqual([{ n: 1 }]);
      expect(stored).toEqual([{ n: 1 }]);
    });

    it("captures the cached append base at invocation", async () => {
      const firstEvent = Promise.withResolvers<void>();
      const requests: Array<{
        type: RequestType;
        value?: unknown;
        values?: unknown[];
      }> = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType; value?: unknown }) => {
            requests.push(structuredClone(request));
            return request.type === RequestType.CellSend
              ? firstEvent.promise.then(() => ({}))
              : Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<Array<{ n: number }>>(
        runtime,
        ref,
        [{ n: 0 }],
      );

      const blocking = cell.sendStrict([]);
      cell.push({ n: 2 });
      cell.get()![0].n = 99;

      firstEvent.resolve();
      await blocking;
      await Promise.resolve();

      expect(requests.find(({ type }) => type === RequestType.CellPush)?.values)
        .toEqual([{ n: 2 }]);
      expect(cell.get()).toEqual([{ n: 0 }, { n: 2 }]);
    });

    it("reports a queued append whose committed value is not an array", async () => {
      const firstWrite = Promise.withResolvers<void>();
      const reported = Promise.withResolvers<unknown[]>();
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType }) =>
            request.type === RequestType.CellSet
              ? firstWrite.promise.then(() => ({}))
              : Promise.resolve({}),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [0]);
      const originalError = console.error;
      console.error = (...args: unknown[]) => reported.resolve(args);

      try {
        const writing = cell.setStrict([1]);
        cell.push(2);
        cell[$onCellUpdate]("not an array" as unknown as number[]);
        firstWrite.resolve();
        await writing;

        const [message, error] = await reported.promise;
        expect(message).toBe("[CellHandle] Push failed:");
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "push() can only be used on array cells",
        );
      } finally {
        console.error = originalError;
      }
    });

    it("reports a rejected append commit", async () => {
      const failure = new Error("commit refused");
      const reported = Promise.withResolvers<unknown[]>();
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType }) =>
            request.type === RequestType.CellPush
              ? Promise.reject(failure)
              : Promise.resolve({}),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [0]);
      const originalError = console.error;
      console.error = (...args: unknown[]) => reported.resolve(args);

      try {
        cell.push(1);

        const [message, error] = await reported.promise;
        expect(message).toBe("[CellHandle] Push failed:");
        expect(error).toBe(failure);
        expect(cell.get()).toEqual([0]);
      } finally {
        console.error = originalError;
      }
    });

    it("rolls back a refused append before a later append", async () => {
      const failure = new Error("commit refused");
      const reported = Promise.withResolvers<void>();
      const secondCommit = Promise.withResolvers<void>();
      let stored = [0];
      let appends = 0;
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType; values?: unknown[] }) => {
            if (request.type !== RequestType.CellPush) {
              return Promise.resolve({});
            }
            if (++appends === 1) return Promise.reject(failure);
            stored = [...stored, ...request.values as number[]];
            secondCommit.resolve();
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [0]);
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        if (args[0] === "[CellHandle] Push failed:") reported.resolve();
      };

      try {
        cell.push(1);
        cell.push(2);
        await Promise.all([reported.promise, secondCommit.promise]);

        expect(stored).toEqual([0, 2]);
        expect(cell.get()).toEqual([0, 2]);
      } finally {
        console.error = originalError;
      }
    });

    it("keeps a later read behind an in-flight append", async () => {
      const appendResponse = Promise.withResolvers<void>();
      const requests: RequestType[] = [];
      const runtime = {
        [$conn]: () => ({
          request: (request: { type: RequestType }) => {
            requests.push(request.type);
            if (request.type === RequestType.CellPush) {
              return appendResponse.promise.then(() => ({}));
            }
            return Promise.resolve({ value: [0, 1] });
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      } as unknown as RuntimeClient;
      const cell = new CellHandle<number[]>(runtime, ref, [0]);

      cell.push(1);
      const reading = cell.sync();
      expect(requests).toEqual([RequestType.CellPush]);

      appendResponse.resolve();
      await reading;
      expect(requests).toEqual([
        RequestType.CellPush,
        RequestType.CellGet,
      ]);
    });
  });

  describe("CellHandle hydration meets a fabric class", () => {
    const makeRuntime = () =>
      ({
        [$conn]: () => ({
          request: () => Promise.resolve({ value: undefined }),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      }) as unknown as RuntimeClient;
    const makeHandle = () =>
      new CellHandle(makeRuntime(), {
        id: "of:hydration-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
      });

    it("hydrates a `FabricPrimitive` as itself, not as a record", () => {
      // A leaf: stopping at it is the whole job, and it must be stopped at
      // before the record branch, which would rebuild it from enumerable own
      // properties it does not have and yield `{}`.
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

      expect(CellHandle.deserialize(makeHandle(), bytes)).toBe(bytes);
      expect(
        (CellHandle.deserialize(makeHandle(), { a: [bytes] }) as {
          a: unknown[];
        }).a[0],
      ).toBe(bytes);
    });

    it("refuses a `FabricInstance` rather than hydrate one", () => {
      // A container, reached by its codec contents rather than by property
      // name, so a sigil link can sit inside one where this walk cannot see
      // it. Nothing delivers one today; this is the tripwire.
      const link = new FabricLink(
        Object.freeze({ id: "of:fid1:hydration-refusal", path: [] }),
      );

      expect(() => CellHandle.deserialize(makeHandle(), link)).toThrow(
        "Cannot yet handle `FabricLink` (a `FabricInstance`)",
      );
    });
  });

  describe("CellHandle special-object refusal", () => {
    // A `FabricSpecialObject` is a `ClientCellValue` -- a cell holds one like
    // any other value -- and `WireCellValue` has no representation for it.
    // Without the refusal, serializing one rebuilds it from its enumerable own
    // properties, putting `{}` on the wire in place of the bytes.

    it("throws for a `FabricBytes` rather than sending an empty record", () => {
      expect(() =>
        CellHandle.serialize(new FabricBytes(new Uint8Array([1, 2, 3])))
      ).toThrow(
        "Cannot yet handle `FabricBytes` (a `FabricSpecialObject`) on this " +
          "connection.",
      );
    });

    it("throws for a `FabricSpecialObject` nested in a record", () => {
      // The branch it has to precede is the record one, so the nested position
      // is the case that pins the ordering rather than merely the check.
      expect(() => CellHandle.serialize({ a: { b: new FabricEpochNsec(1n) } }))
        .toThrow(
          "Cannot yet handle `FabricEpochNsec` (a `FabricSpecialObject`) on this " +
            "connection.",
        );
    });

    it("throws for a `FabricSpecialObject` nested in an array", () => {
      expect(() => CellHandle.serialize([new FabricBytes(new Uint8Array([7]))]))
        .toThrow(
          "Cannot yet handle `FabricBytes` (a `FabricSpecialObject`) on this " +
            "connection.",
        );
    });

    it("serializes an ordinary record unchanged", () => {
      // The refusal must not claim a plain record on its way past.
      //
      // `toStrictEqual`, because `toEqual` ignores an `undefined`-valued key in
      // both directions -- so it would pass just as well if `c` were dropped
      // entirely. Carrying a _present_ `undefined` is one of the two properties
      // `WireCellValue` exists to have over `JSONValue`, which makes it the half
      // of this fixture most worth actually asserting.
      expect(CellHandle.serialize({ a: 1, b: [true, null], c: undefined }))
        .toStrictEqual({ a: 1, b: [true, null], c: undefined });
    });
  });

  describe("CellHandle refused writes", () => {
    const ref: CellRef = {
      id: "of:refused-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    const runtimeCapturing = (requests: unknown[]): RuntimeClient =>
      ({
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      }) as unknown as RuntimeClient;

    // The local update is optimistic about the _write_ landing, not about
    // whether the value can be sent at all. A value the connection refuses is
    // one the runtime will never hold, so it must not become the cached value or
    // reach a subscriber -- that would show state that does not exist anywhere.

    it("keeps the prior value after a refused set", async () => {
      const cell = new CellHandle<unknown>(runtimeCapturing([]), ref);
      cell[$onCellUpdate]("before");

      await expect(cell.set(new FabricBytes(new Uint8Array([1])))).rejects
        .toThrow("Cannot yet handle `FabricBytes`");

      expect(cell.get()).toBe("before");
    });

    it("notifies no subscriber of a refused set", async () => {
      const cell = new CellHandle<unknown>(runtimeCapturing([]), ref);
      cell[$onCellUpdate]("before");
      const seen: unknown[] = [];
      cell.subscribe((value) => {
        seen.push(value);
      });
      seen.length = 0; // Drop any initial delivery; what follows is the point.

      await expect(cell.set(new FabricBytes(new Uint8Array([1])))).rejects
        .toThrow("Cannot yet handle `FabricBytes`");

      expect(seen).toEqual([]);
    });

    it("sends nothing over the connection for a refused set", async () => {
      const requests: unknown[] = [];
      const cell = new CellHandle<unknown>(runtimeCapturing(requests), ref);

      await expect(cell.set(new FabricBytes(new Uint8Array([1])))).rejects
        .toThrow("Cannot yet handle `FabricBytes`");

      expect(requests).toEqual([]);
    });
  });

  describe("CellHandle refusal reaches every write path", () => {
    const ref: CellRef = {
      id: "of:paths-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    const runtimeCapturing = (requests: unknown[]): RuntimeClient =>
      ({
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(request);
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      }) as unknown as RuntimeClient;

    // Three methods serialize, and each refuses through a different caller
    // contract: `set()` rejects, `send()` rejects, and `push()` throws
    // synchronously out of a `void` return. Pinning all three is what keeps a
    // later refactor from moving the check somewhere only `set()` reaches.

    it("throws synchronously out of `push()`, which returns void", () => {
      const requests: unknown[] = [];
      const cell = new CellHandle<unknown[]>(runtimeCapturing(requests), ref);
      cell[$onCellUpdate]([1, 2]);

      expect(() => cell.push(new FabricBytes(new Uint8Array([1])))).toThrow(
        "Cannot yet handle `FabricBytes`",
      );
      expect(requests).toEqual([]);
      // The read-modify-write left the cached array alone.
      expect(cell.get()).toEqual([1, 2]);
    });

    it("rejects from `send()` without reaching the connection", async () => {
      const requests: unknown[] = [];
      const cell = new CellHandle<unknown>(runtimeCapturing(requests), ref);

      await expect(cell.send(new FabricBytes(new Uint8Array([1])))).rejects
        .toThrow("Cannot yet handle `FabricBytes`");
      expect(requests).toEqual([]);
    });

    it("rejects a `bigint`, which no arm of the wire type carries", async () => {
      // Not an object, so the `FabricSpecialObject` check cannot catch it. It is
      // a `FabricValue` arm all the same, so a cell holds one and
      // `ClientCellValue` admits one -- the same gap, for an arm that is not an
      // object. The message names the kind, since `1n` prints as `1` and would
      // otherwise read as a number refused for no reason.
      const cell = new CellHandle<unknown>(runtimeCapturing([]), ref);

      await expect(cell.set(1n)).rejects.toThrow(
        "Cannot send a `bigint` on this connection",
      );
    });
  });
});
