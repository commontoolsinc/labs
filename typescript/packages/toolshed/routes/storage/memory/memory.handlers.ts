import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./memory.routes.ts";
import * as Memory from "@commontools/memory";
import env from "@/env.ts";

const { ok: memory, error } = await Memory.open({
  store: new URL(env.MEMORY_URL),
});

if (error) {
  throw error;
}

export const transact: AppRouteHandler<typeof Routes.transact> = (c) =>
  // @ts-expect-error - AppRouteHandler does not like Promise<Response> here as
  // it wants to know status code and not sure how to use my own response
  memory.patch(c.req);

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (c) => {
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  memory.subscribe(socket);
  return response;
};

export const query: AppRouteHandler<typeof Routes.query> = (c) =>
  // @ts-expect-error - Same reason as transact handler
  memory.query(c.req);
