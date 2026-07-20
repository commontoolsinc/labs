import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "./mod.ts";
import { cellRefToKey } from "./shared/utils.ts";
import { linkRefPayloadFromString } from "@commonfabric/runner/shared";

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

  it("a value-only notification leaves the cached label untouched", () => {
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
