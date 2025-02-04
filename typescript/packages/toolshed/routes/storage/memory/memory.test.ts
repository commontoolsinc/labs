import { assertEquals } from "@std/assert";
import createApp from "@/lib/create-app.ts";
import env from "@/env.ts";
import router from "./memory.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

const space = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const entity = "baedreigv6dnlwjzyyzk2z2ld2kapmu6hvqp46f3axmgdowebqgbts5jksi";

Deno.test("test subscription", async (t) => {
  const server = Deno.serve(app.fetch);

  console.log(`trying to connect to http://${server.addr.hostname}:${server.addr.port}`);

  const socket = new WebSocket(
    `http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  await new Promise((resolve) => (socket.onopen = resolve));

  console.log(`Socket connected`);

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
  console.log("received message", event);

  assertEquals(JSON.parse((event as MessageEvent).data), {
    [space]: {
      the: "application/json",
      of: entity,
    },
  });

  socket.close();
  await server.shutdown();
});
