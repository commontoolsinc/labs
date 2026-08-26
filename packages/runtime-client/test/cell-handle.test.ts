import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { linkRefPayloadFromString } from "@commonfabric/runner/shared";

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
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";

describe("cell-handle", () => {
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
      // Two `FabricBytes` holding different bytes are different values. Their
      // state is private, so a walk over enumerable own properties sees `{}`
      // on both sides and calls them equal -- which would keep the old value
      // and tell no subscriber. Now that the connection carries one of these
      // intact, that comparison is reachable.
      const cell = new CellHandle<FabricBytes>(makeRuntime(), ref);
      const calls: Array<unknown> = [];
      cell.subscribe((value) => {
        calls.push(value);
      });

      cell[$onCellUpdate](new FabricBytes(new Uint8Array([1])));
      const after = calls.length;
      cell[$onCellUpdate](new FabricBytes(new Uint8Array([2])));

      expect(calls.length).toBe(after + 1);
      expect((calls.at(-1) as FabricBytes).slice()).toEqual(
        new Uint8Array([2]),
      );
    });

    it("does not re-notify when a special object is unchanged", () => {
      const cell = new CellHandle<FabricBytes>(makeRuntime(), ref);
      const calls: Array<unknown> = [];
      cell.subscribe((value) => {
        calls.push(value);
      });

      cell[$onCellUpdate](new FabricBytes(new Uint8Array([1, 2])));
      const after = calls.length;
      cell[$onCellUpdate](new FabricBytes(new Uint8Array([1, 2])));

      expect(calls.length).toBe(after);
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

  describe("CellHandle carries a special object", () => {
    const makeRuntime = () =>
      ({
        [$conn]: () => ({
          request: () => Promise.resolve({ value: undefined }),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        }),
      }) as unknown as RuntimeClient;
    const makeRef = (): CellRef => ({
      id: "of:special-object-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    });

    // A `FabricSpecialObject` is a `ClientCellValue` -- a cell holds one like
    // any other value -- and it now crosses as itself. What this pins is that
    // `serialize()` hands it on WHOLE rather than walking it: rebuilding one
    // from its enumerable own properties would put `{}` on the wire in place
    // of the bytes, which is what the ordering of the checks prevents.

    it("returns a `FabricBytes` as itself, not as a record", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

      const wire = CellHandle.serialize(bytes);

      expect(wire).toBe(bytes);
      expect(wire).toBeInstanceOf(FabricBytes);
    });

    it("returns one nested in a record as itself", () => {
      // The branch this has to precede is the record one, so the nested
      // position is the case that pins the ordering rather than the check.
      const nsec = new FabricEpochNsec(1n);

      const wire = CellHandle.serialize({ a: { b: nsec } }) as {
        a: { b: unknown };
      };

      expect(wire.a.b).toBe(nsec);
    });

    it("returns one nested in an array as itself", () => {
      const bytes = new FabricBytes(new Uint8Array([7]));

      const wire = CellHandle.serialize([bytes]) as unknown[];

      expect(wire[0]).toBe(bytes);
    });

    it("hydrates a `FabricBytes` as itself, not as a record", () => {
      // The inbound counterpart of the three above. `deserialize()` walks what
      // the worker sent, and its record branch rebuilds from enumerable own
      // properties a fabric class does not have -- so without the same
      // ordering the value the connection just carried whole arrives as `{}`.
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      const handle = new CellHandle(makeRuntime(), makeRef());

      const hydrated = CellHandle.deserialize(handle, bytes);

      expect(hydrated).toBe(bytes);
    });

    it("hydrates one nested in a record and in an array as itself", () => {
      const nsec = new FabricEpochNsec(1n);
      const bytes = new FabricBytes(new Uint8Array([7]));
      const handle = new CellHandle(makeRuntime(), makeRef());

      const hydrated = CellHandle.deserialize(handle, {
        a: { b: nsec },
        c: [bytes],
      }) as { a: { b: unknown }; c: unknown[] };

      expect(hydrated.a.b).toBe(nsec);
      expect(hydrated.c[0]).toBe(bytes);
    });

    it("returns a `bigint` and a `symbol` as themselves", () => {
      // Both are `FabricValue` arms that the connection used to refuse
      // outright, for want of anywhere to put them.
      const marker = Symbol.for("a-marker");

      expect(CellHandle.serialize(7n)).toBe(7n);
      expect(CellHandle.serialize(marker)).toBe(marker);
    });

    it("serializes an ordinary record unchanged", () => {
      // The special-object branch must not claim a plain record on its way
      // past.
      //
      // `toStrictEqual`, because `toEqual` ignores an `undefined`-valued key
      // in both directions -- so it would pass just as well if `c` were
      // dropped entirely. Carrying a _present_ `undefined` is one of the
      // properties `WireCellValue` exists to have over `JSONValue`, which
      // makes it the half of this fixture most worth actually asserting.
      expect(CellHandle.serialize({ a: 1, b: [true, null], c: undefined }))
        .toStrictEqual({ a: 1, b: [true, null], c: undefined });
    });
  });

  describe("CellHandle write that cannot cross", () => {
    const ref: CellRef = {
      id: "of:uncrossable-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    /** A connection that encodes, as the real transport does when it sends. */
    const encodingRuntime = (): RuntimeClient =>
      ({
        [$conn]: () => ({
          request: (request: unknown) => {
            realmFromFabricValue(request as never);
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      }) as unknown as RuntimeClient;

    it("surfaces the failure to the caller rather than swallowing it", async () => {
      // An object forged onto a `FabricPrimitive`'s prototype is a
      // `FabricValue` by every check and still has no encoding, so it is what
      // can fail a send now that the domain's real members all cross. The
      // caller has to learn that their write never happened; the alternative
      // is a `set()` that resolves over a value the runtime never saw.
      const cell = new CellHandle<unknown>(encodingRuntime(), ref);

      await expect(cell.set(Object.create(FabricBytes.prototype))).rejects
        .toThrow();
    });
  });

  describe("CellHandle carries a value on every write path", () => {
    const ref: CellRef = {
      id: "of:paths-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    /**
     * A runtime whose connection encodes each request as the real transport
     * does, so what a test reads back is what would actually have crossed. A
     * double that merely captured the object would report a fidelity this
     * connection might not have.
     */
    const runtimeCapturing = (requests: unknown[]): RuntimeClient =>
      ({
        [$conn]: () => ({
          request: (request: unknown) => {
            requests.push(
              fabricFromRealmValue(realmFromFabricValue(request as never)),
            );
            return Promise.resolve({});
          },
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      }) as unknown as RuntimeClient;

    // Three methods serialize, and each used to refuse a `FabricSpecialObject`
    // through a different caller contract. All three carry one now, and
    // pinning all three is what keeps a later refactor from carrying it on
    // only the path `set()` takes.

    it("carries one through `push()`", () => {
      const requests: Array<{ value?: unknown }> = [];
      const cell = new CellHandle<unknown[]>(runtimeCapturing(requests), ref);
      cell[$onCellUpdate]([1, 2]);

      cell.push(new FabricBytes(new Uint8Array([1])));

      expect(requests).toHaveLength(1);
      const pushed = requests[0].value as unknown[];
      expect(pushed[2]).toBeInstanceOf(FabricBytes);
      expect((pushed[2] as FabricBytes).slice()).toEqual(new Uint8Array([1]));
    });

    it("carries one through `send()`", async () => {
      const requests: Array<{ event?: unknown }> = [];
      const cell = new CellHandle<unknown>(runtimeCapturing(requests), ref);

      await cell.send(new FabricBytes(new Uint8Array([1])));

      expect(requests).toHaveLength(1);
      expect(requests[0].event).toBeInstanceOf(FabricBytes);
    });

    it("carries a `bigint` through `set()`", async () => {
      // Not an object, so the `FabricSpecialObject` branch never sees it. It
      // is a `FabricValue` arm all the same, and the encoding carries one as
      // itself rather than as the `1` its text would suggest.
      const requests: Array<{ value?: unknown }> = [];
      const cell = new CellHandle<unknown>(runtimeCapturing(requests), ref);

      await cell.set(1n);

      expect(requests).toHaveLength(1);
      expect(requests[0].value).toBe(1n);
    });
  });
});
