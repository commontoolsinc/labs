import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { NoCache, Replica } from "../src/storage/cache.ts";
import type { IStorageSubscription } from "../src/storage/interface.ts";
import type { SchemaQueryArgs } from "@commontools/memory/interface";
import type { MemorySpaceSession } from "@commontools/memory/consumer";
import { normalizeConfidentialityLabel } from "../src/cfc/label-algebra.ts";

const signer = await Identity.fromPassphrase("cfc storage query test");
const space = signer.did();

describe("CFC storage query classification", () => {
  it("preserves CNF confidentiality when pulling with schema selectors", async () => {
    const captured: SchemaQueryArgs[] = [];
    const remote = {
      as: signer,
      flush() {
        return Promise.resolve({ ok: {} });
      },
      transact() {
        throw new Error("not used in test");
      },
      query(queryArgs: SchemaQueryArgs) {
        captured.push(queryArgs);
        return {
          promise: Promise.resolve({
            ok: {
              schemaFacts: [],
            },
          }),
        };
      },
    } as unknown as MemorySpaceSession;
    const subscription: IStorageSubscription = {
      next() {
        return undefined;
      },
    };
    const replica = new Replica(
      space,
      remote,
      subscription,
      new NoCache(),
      undefined,
    );
    const schema = {
      type: "object",
      ifc: {
        classification: [
          [{
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:alice",
          }],
          ["https://commonfabric.org/cfc/atom/EmailSecret"],
        ],
      },
    } as const satisfies JSONSchema;

    await replica.pull([[
      {
        id: "of:cfc-query-doc",
        type: "application/json",
      },
      {
        path: [],
        schema,
      },
    ]]);

    expect(captured).toHaveLength(1);
    expect(normalizeConfidentialityLabel(captured[0].classification)).toEqual(
      normalizeConfidentialityLabel([
        [{
          type: "https://commonfabric.org/cfc/atom/User",
          subject: "did:key:alice",
        }],
        ["https://commonfabric.org/cfc/atom/EmailSecret"],
      ]),
    );
  });
});
