import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./memory.routes.ts";
import * as Memory from "@commontools/memory";
import env from "@/env.ts";

const { ok: memory, error } = await Memory.Provider.open({
  store: new URL(env.MEMORY_URL),
});

if (error) {
  throw error;
}

export const transact: AppRouteHandler<typeof Routes.transact> = async (c) => {
  try {
    const transaction = await c.req.valid("json");
    const result = await memory.transact(transaction as Memory.Transaction);

    if (result.ok) {
      return c.json(result, 200);
    } else {
      // This is ugly but without this TS inference is failing to infer that
      // types are correct
      const { error } = result;
      if (error.name === "ConflictError") {
        return c.json({ error }, 409);
      } else {
        return c.json({ error }, 503);
      }
    }
  } catch (cause) {
    const { message, stack, name } = (cause ?? new Error(cause as any)) as Error;
    return c.json({ error: { message, name, stack } }, 500);
  }
};

export const query: AppRouteHandler<typeof Routes.query> = async (c) => {
  try {
    const query = await c.req.valid("json");
    const result = await memory.query(query);
    if (result.ok) {
      return c.json(result, 200);
    } else {
      return c.json(result, 503);
    }
  } catch (cause) {
    const { message, stack, name } = (cause ?? new Error(cause as any)) as Error;
    return c.json({ error: { message, name, stack } }, 500);
  }
};

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = async (c) => {
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  const session = Memory.Socket.from(socket);
  session.readable.pipeThrough(memory.session()).pipeTo(session.writable);
  return response;
};
