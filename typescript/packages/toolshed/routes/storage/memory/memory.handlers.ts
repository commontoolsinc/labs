import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./memory.routes.ts";
import * as Memory from "@commontools/memory";
import * as Path from "jsr:@std/path";
import env from "@/env.ts";

const { ok: memory, error } = await Memory.open({
  store: new URL(env.MEMORY_URL),
});

if (error) {
  throw error;
}

// @ts-expect-error - AppRouteHandler does not like Promise<Response> here as
// it wants to know status code and not sure how to use my own response
export const transact: AppRouteHandler<typeof Routes.transact> = (c) =>
  memory.patch(c.req.raw);

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (
  c,
): Response => {
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  memory.subscribe(socket);
  return response;
};
