import { assertEquals } from "@std/assert";
import env from "@/env.ts";
import app from "../../../app.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const space = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";

Deno.test("test transaction", async (t) => {
  const entity = "baedreigv6dnlwjzyyzk2z2ld2kapmu6hvqp46f3axmgdowebqgbts5jksi";
  const response = await app.fetch(
    new Request("http://localhost/api/storage/memory", {
      method: "patch",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        [space]: {
          assert: {
            the: "application/json",
            of: entity,
            is: { hello: "world" },
          },
        },
      }),
    }),
  );

  assertEquals(response.status, 200);
  const json = await response.json();
  assertEquals(json, {
    ok: {
      the: "application/json",
      of: entity,
      is: { hello: "world" },
      cause: {
        "/": "baedreiayyshoe2moi4rexyuxp2ag7a22sfymkytfph345g6dmfqtoesabm",
      },
    },
  });
});

Deno.test("test subscription", async (t) => {
  const server = Deno.serve(app.fetch);
  const entity = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";

  const url = new URL(`http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`);
  const socket = new WebSocket(url.href);

  await new Promise((resolve) => (socket.onopen = resolve));

  socket.send(
    JSON.stringify({
      watch: {
        [space]: {
          the: "application/json",
          of: entity,
        },
      },
    }),
  );

  const event = await new Promise((resolve) => (socket.onmessage = resolve));

  assertEquals(JSON.parse(((await event) as MessageEvent).data), {
    [space]: {
      the: "application/json",
      of: entity,
    },
  });

  socket.close();
  await server.shutdown();
});
