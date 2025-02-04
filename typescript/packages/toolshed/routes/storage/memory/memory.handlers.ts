import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./memory.routes.ts";
import * as Memory from "@commontools/memory";
import env from "@/env.ts";
import { upgradeWebSocket } from "hono/deno";

const { ok: memory, error } = await Memory.open({
  store: new URL(env.MEMORY_URL),
});

if (error) {
  throw error;
}

export const transact: AppRouteHandler<typeof Routes.transact> = (c) =>
  // @ts-expect-error - AppRouteHandler does not like Promise<Response> here as
  // it wants to know status code and not sure how to use my own response
  memory.patch(c.req.raw);

// export const subscribe = upgradeWebSocket((c) => {
//   console.log("subscribe request", c);
//   return {
//     onOpen(event, ws) {
//       console.log("Open WS connection");
//       memory.subscribe(ws.raw as WebSocket);
//     },
//     onClose: () => {
//       console.log("Connection closed");
//     },
//   };
// });
export const subscribe: AppRouteHandler<typeof Routes.subscribe> = async (c) => {
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  console.log("upgraded request to WS");
  memory.subscribe(socket);
  console.log("subscribed");
  return response;
};

export const subscribe2 = upgradeWebSocket((c) => {
  return {
    onOpen(event, ws) {
      memory.subscribe(ws.raw!);
    },
  };
});
