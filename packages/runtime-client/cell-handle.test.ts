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

  it("serializes ref-carried label views into transient sigil links", () => {
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
          cfcLabelView: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["selected-by-alice"] },
            }],
          },
        },
      },
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
});
