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
import { cellRefToKey } from "@/shared/utils.ts";

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
  });

  describe("CellHandle push (read-modify-write)", () => {
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

    it("sends a CellPush carrying the appended array (not a blind CellSet)", () => {
      const requests: unknown[] = [];
      const cell = new CellHandle<number[]>(runtimeCapturing(requests), ref);
      // Seed the local cache so push has an array to read-modify-write.
      cell[$onCellUpdate]([1, 2]);

      cell.push(3);

      expect(requests.length).toBe(1);
      const request = requests[0] as { type: unknown; value: unknown };
      // Routed as CellPush (compare-and-set) rather than the blind CellSet, and
      // it carries the whole client-computed array.
      expect(request.type).toBe(RequestType.CellPush);
      expect(request.value).toEqual([1, 2, 3]);
    });

    it("throws when the cell is not an array", () => {
      const cell = new CellHandle<number[]>(runtimeCapturing([]), ref);
      cell[$onCellUpdate]("not an array" as unknown as number[]);
      expect(() => cell.push(1)).toThrow(
        "push() can only be used on array cells",
      );
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
