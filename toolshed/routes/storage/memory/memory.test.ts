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
} from "@commontools/memory";
import * as Commit from "@commontools/memory/commit";
import { Identity } from "@commontools/identity";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const the = "application/json";
const doc = `of:${refer({ hello: "world" })}` as const;

export const alice = await Identity.fromString(
  "MU+bzp2GaFQHso587iSFWPSeCzbSfn/CbNHEz7ilKRZ0=",
);

export const space = await Identity.fromString(
  "MCl6B1cu1ZOP0I3BBovjAqo57VImrMVyfLiSmNKoddXs=",
);

const toJSON = <T>(source: T) => JSON.parse(JSON.stringify(source));

Deno.test("test transaction", async (t) => {
  const server = Deno.serve({ port: 9000 }, app.fetch);
  const address = new URL(
    `http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const memory = Consumer.connect({
      address,
      as: space,
    });
    const home = memory.mount(space.did());

    const hello = Fact.assert({
      the,
      of: doc,
      is: { hello: "world" },
    });

    const transaction = TransactionBuilder.create({
      issuer: space.did(),
      subject: space.did(),
      changes: ChangesBuilder.from([hello]),
    });

    const result = await home.transact({
      changes: ChangesBuilder.from([hello]),
    });

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
    Deno.removeSync(new URL(`./${space.did()}.sqlite`, env.MEMORY_DIR));
  }
});

Deno.test("test consumer", async (t) => {
  const server = Deno.serve({ port: 9000 }, app.fetch);
  const address = new URL(
    `http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
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
    const commit = Commit.toRevision(tr.ok);

    const message = await subscription.getReader().read();
    assertEquals(message.done, false);

    assertEquals(query.facts, [{ ...fact, since: commit.is.since }]);

    session.close();
  } finally {
    await server.shutdown();
    Deno.removeSync(new URL(`./${alice.did()}.sqlite`, env.MEMORY_DIR));
  }
});
