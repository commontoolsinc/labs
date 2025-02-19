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
import * as FS from "@std/fs";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const the = "application/json";
const doc = `of:${refer({ hello: "world" })}` as const;
const space = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";

const toJSON = <T>(source: T) => JSON.parse(JSON.stringify(source));

Deno.test("test transaction", async (t) => {
  try {
    const hello = Fact.assert({
      the,
      of: doc,
      is: { hello: "world" },
    });

    const transaction = TransactionBuilder.create({
      issuer: alice,
      subject: space,
      changes: ChangesBuilder.from([hello]),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/storage/memory", {
        method: "patch",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(transaction),
      }),
    );

    assertEquals(response.status, 200);
    const json = await response.json();

    assertEquals(json, {
      ok: ChangesBuilder.from([
        CommitBuilder.create({
          space,
          transaction,
        }),
      ]),
    });
  } finally {
    Deno.removeSync(new URL(`./${space}.sqlite`, env.MEMORY_URL));
  }
});

Deno.test("test consumer", async (t) => {
  try {
    const server = Deno.serve({ port: 9000 }, app.fetch);

    const url = new URL(
      `http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
    );

    const session = Consumer.connect({ address: url, as: alice });
    const memory = session.mount(alice);

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

    await server.shutdown();
  } finally {
    Deno.removeSync(new URL(`./${alice}.sqlite`, env.MEMORY_URL));
  }
});
