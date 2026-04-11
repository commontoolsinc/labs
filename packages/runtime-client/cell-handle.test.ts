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
        label: { classification: ["prompt-risk"] },
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
});
