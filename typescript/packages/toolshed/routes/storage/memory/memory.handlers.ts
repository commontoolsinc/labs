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

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (
  c,
): Response => {
  return upgradeWebSocket((c) => {
    return {
      onMessage(event, ws) {
        console.log(`Message from client: ${event.data}`);
        // ws.send("Hello from server!");
        memory.subscribe(ws.raw as WebSocket);
      },
      onClose: () => {
        console.log("Connection closed");
      },
    };
  });
};
