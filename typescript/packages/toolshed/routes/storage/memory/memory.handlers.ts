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

export const transact: AppRouteHandler<typeof Routes.transact> = async (c) => {
  try {
    const parsedBody = await c.req.json();
    const result = await memory.patchJson(parsedBody);

    if ("error" in result) {
      const status = result.error?.name === "ConflictError" ? 409 : 500;
      return c.json({ error: result.error?.message }, status);
    }

    return c.json({ ok: result.ok }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
};

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (c) => {
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  memory.subscribe(socket);
  return response;
};

export const query: AppRouteHandler<typeof Routes.query> = async (c) => {
  try {
    const selector = await c.req.json();
    const result = await memory.queryJson(selector);
    if ("error" in result) {
      return c.json({ error: result.error?.message || "Unknown error" }, 500);
    }
    return c.json({ ok: result.ok }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
};
