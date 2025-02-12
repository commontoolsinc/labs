import { assertEquals } from "@std/assert";
import env from "@/env.ts";
import app from "../../../app.ts";
import { refer } from "merkle-reference";
import { Space } from "@commontools/memory";
import * as FS from "@std/fs";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const the = "application/json";
const doc = refer({ hello: "world" }).toString();
const space = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";

const toJSON = <T>(source: T) => JSON.parse(JSON.stringify(source));

Deno.test("test transaction", async (t) => {
  try {
    const transaction = {
      cmd: "/memory/transact",
      iss: alice,
      sub: space,
      args: {
        changes: {
          [the]: {
            [doc]: {
              [refer({ the, of: doc }).toString()]: {
                is: { hello: "world" },
              },
            },
          },
        },
      },
    } as const;

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
      ok: toJSON(
        Space.toCommit({
          subject: space,
          is: {
            since: 0,
            transaction,
          },
        }),
      ),
    });
  } finally {
    Deno.removeSync(new URL(`./${space}.sqlite`, env.MEMORY_URL));
  }
});

Deno.test("test subscription", async (t) => {
  try {
    const server = Deno.serve({ port: 9000 }, app.fetch);

    const url = new URL(`http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`);
    const socket = new WebSocket(url.href);

    await new Promise((resolve) => (socket.onopen = resolve));

    socket.send(
      JSON.stringify({
        watch: {
          cmd: "/memory/query",
          iss: alice,
          sub: alice,
          args: {
            selector: {
              the,
              of: doc,
            },
          },
        },
      }),
    );

    const event = await new Promise((resolve) => (socket.onmessage = resolve));

    assertEquals(JSON.parse(((await event) as MessageEvent).data), {
      brief: {
        sub: alice,
        args: {
          selector: { the, of: doc },
          selection: [],
        },
      },
    });

    socket.close();
    await server.shutdown();
  } finally {
    Deno.removeSync(new URL(`./${alice}.sqlite`, env.MEMORY_URL));
  }
});
