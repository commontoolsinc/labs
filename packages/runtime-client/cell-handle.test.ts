import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  $conn,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "./mod.ts";

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
      type: "application/json",
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
      type: "application/json",
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
        type: ref.type,
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

  it("does not serialize ref-carried label views into sigil links", () => {
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
      type: "application/json",
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
          type: "application/json",
          path: ["value"],
        },
      },
    });
  });
});
