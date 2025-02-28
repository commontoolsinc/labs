import { assert, assertEquals } from "@std/assert";
import env from "@/env.ts";
import app from "../../../app.ts";
import { refer } from "merkle-reference";
import {
  ChangesBuilder,
  CommitBuilder,
  Consumer,
  Fact,
  TransactionBuilder,
  Principal,
} from "@commontools/memory";
import * as FS from "@std/fs";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const the = "application/json";
const doc = `of:${refer({ hello: "world" })}` as const;

export const alice =
  Principal.ED25519Signer.fromString<"did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi">(
    "MgCZT5vOnYZoVAeyjnzuJIVY9J4LNtJ+f8Js0cTPuKUpFne0BVEDJjEu6quFIU8yp91/TY/+MYK8GvlKoTDnqOCovCVM=",
  );

export const space =
  Principal.ED25519Signer.fromString<"did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z">(
    "MgCYKXoHVy7Vk4/QjcEGi+MCqjntUiasxXJ8uJKY0qh11e+0Bs8WsdqGK7xothgrDzzWD0ME7ynPjz2okXDh8537lId8=",
  );

const toJSON = <T>(source: T) => JSON.parse(JSON.stringify(source));

Deno.test("test transaction", async (t) => {
  const server = Deno.serve({ port: 9000 }, app.fetch);
  const address = new URL(`http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`);

  try {
    const memory = Consumer.connect({
      address,
      as: alice,
    });
    const home = memory.mount(space.did());

    const hello = Fact.assert({
      the,
      of: doc,
      is: { hello: "world" },
    });

    const transaction = TransactionBuilder.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: ChangesBuilder.from([hello]),
    });

    console.log(">> transaction");

    const result = await home.transact({
      changes: ChangesBuilder.from([hello]),
    });

    console.log("<< transaction");

    assertEquals(result, {
      ok: ChangesBuilder.from([
        CommitBuilder.create({
          space: space.did(),
          transaction,
        }),
      ]),
    });

    memory.close();
  } finally {
    await server.shutdown();
    Deno.removeSync(new URL(`./${space.did()}.sqlite`, env.MEMORY_URL));
  }
});

Deno.test("test consumer", async (t) => {
  const server = Deno.serve({ port: 9000 }, app.fetch);
  const address = new URL(`http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`);
  try {
    const session = Consumer.connect({ address, as: alice });
    const memory = session.mount(alice.did());

    const result = await memory.query({
      select: {
        [doc]: {
          [the]: {},
        },
      },
    });

    assert(result.ok);
    const query = result.ok;
    assertEquals(query.facts, []);

    const subscription = query.subscribe();

    const fact = Fact.assert({ the, of: doc, is: { first: "doc" } });
    const tr = await memory.transact({
      changes: ChangesBuilder.from([fact]),
    });

    assert(tr.ok);

    const message = await subscription.getReader().read();
    assertEquals(message.done, false);

    assertEquals(query.facts, [fact]);

    session.close();
  } finally {
    await server.shutdown();
    Deno.removeSync(new URL(`./${alice.did()}.sqlite`, env.MEMORY_URL));
  }
});
