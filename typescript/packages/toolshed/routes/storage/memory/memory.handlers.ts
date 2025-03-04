import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./memory.routes.ts";
import { Memory, memory } from "../memory.ts";
import * as Codec from "@commontools/memory/codec";

export const transact: AppRouteHandler<typeof Routes.transact> = async (c) => {
  try {
    const ucan = (await c.req.valid("json")) as Memory.UCAN<
      Memory.ConsumerInvocationFor<"/memory/transact", Memory.Protocol>
    >;
    const result = await memory.invoke(ucan);
    if (result.ok) {
      return c.json(result, 200);
    } else {
      // This is ugly but without this TS inference is failing to infer that
      // types are correct
      const { error } = result;
      if (error.name === "ConflictError") {
        return c.json({ error }, 409);
      } else if (error.name === "AuthorizationError") {
        return c.json({ error }, 401);
      } else {
        return c.json({ error }, 503);
      }
    }
  } catch (cause) {
    const { message, stack, name } =
      (cause ?? new Error(cause as any)) as Error;
    return c.json({ error: { message, name, stack } }, 500);
  }
};

export const query: AppRouteHandler<typeof Routes.query> = async (c) => {
  try {
    const ucan = (await c.req.valid("json")) as Memory.UCAN<
      Memory.ConsumerInvocationFor<"/memory/query", Memory.Protocol>
    >;
    const { ok, error } = await memory.invoke(ucan);

    if (ok) {
      return c.json({ ok }, 200);
    } else if (error.name === "AuthorizationError") {
      return c.json({ error }, 401);
    } else {
      return c.json({ error }, 503);
    }
  } catch (cause) {
    const { message, stack, name } =
      (cause ?? new Error(cause as any)) as Error;
    return c.json({ error: { message, name, stack } }, 500);
  }
};

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (c) => {
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  const { readable, writable } = Memory.Socket.from<string, string>(socket);
  readable
    .pipeThrough(Codec.UCAN.fromStringStream())
    .pipeThrough(memory.session())
    .pipeThrough(Codec.Receipt.toStringStream())
    .pipeTo(writable);
  return response;
};
