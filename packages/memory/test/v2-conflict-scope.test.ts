/** Scoped conflict addresses survive the server response and client decoding. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type CellScope, toDocumentPath } from "../v2.ts";
import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("v2-conflict-scope", () => {
  for (const scope of ["space", "user", "session"] as const) {
    it(`returns the conflicting ${scope} instance when another scope shares its ID`, async () => {
      const server = new Server({
        store: new URL("memory://conflict-scope"),
        subscriptionRefreshDelayMs: "manual",
        ...testSessionOpenServerOptions,
      });
      const client = await connect({ transport: loopback(server) });
      try {
        const session = await client.mount(
          "did:key:conflict-scope",
          {},
          testSessionOpenAuthFactory,
        );
        const scopes: CellScope[] = ["space", "user", "session"];
        const seeded = await session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: scopes.map((scope) => ({
            op: "set",
            id: "of:shared-id",
            scope,
            value: { value: scope },
          })),
        });
        const otherScope = scope === "space" ? "user" : "space";
        await expect(session.transact({
          localSeq: 2,
          reads: {
            confirmed: [{
              id: "of:shared-id",
              scope: otherScope,
              path: toDocumentPath(["value"]),
              seq: seeded.seq,
            }, {
              id: "of:shared-id",
              scope,
              path: toDocumentPath(["value"]),
              seq: 0,
            }],
            pending: [],
          },
          operations: [{
            op: "set",
            id: "of:separate-output",
            value: { value: "updated" },
          }],
        })).rejects.toMatchObject({
          name: "ConflictError",
          conflict: { of: "of:shared-id", scope },
          retryAfterSeq: seeded.seq,
        });
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
