import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { PageHandle } from "./page-handle.ts";
import { $conn, type RuntimeClient } from "./runtime-client.ts";
import { type CellRef, RequestType } from "./protocol/mod.ts";

// Federation PR2: PageHandle.start/stop carry their cell's space so a
// handle for a foreign-space page routes to that space's piece context
// (a home-space handle carries the home space, which resolves to the
// same context as the no-space form).
describe("PageHandle start/stop space threading", () => {
  const space = "did:key:z6Mk-page-handle-space" as DID;

  function makeHandle() {
    const requests: Array<Record<string, unknown>> = [];
    const conn = {
      request: (req: Record<string, unknown>) => {
        requests.push(req);
        return Promise.resolve({ value: true });
      },
    };
    const client = { [$conn]: () => conn } as unknown as RuntimeClient;
    const ref: CellRef = {
      id: "of:fid1-page-handle-probe" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const handle = new PageHandle(client, { cell: ref });
    return { handle, requests };
  }

  it("start sends the cell's space", async () => {
    const { handle, requests } = makeHandle();
    await expect(handle.start()).resolves.toBe(true);
    expect(requests).toEqual([{
      type: RequestType.PageStart,
      pageId: "fid1-page-handle-probe",
      space,
    }]);
  });

  it("stop sends the cell's space", async () => {
    const { handle, requests } = makeHandle();
    await expect(handle.stop()).resolves.toBe(true);
    expect(requests).toEqual([{
      type: RequestType.PageStop,
      pageId: "fid1-page-handle-probe",
      space,
    }]);
  });
});
