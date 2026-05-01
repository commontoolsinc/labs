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
      path: [],
      schema: true,
    };
    const childRef = {
      id: "of:cfc-label-child",
      space: "did:key:test",
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
