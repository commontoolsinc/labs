import { createRouter } from "@/lib/create-app.ts";
import type { AppBindings } from "@/lib/types.ts";
import { isMemoryWireAccountingEnabled } from "./memory-wire-accounting-policy.ts";
import type { MemoryWireAccountingAccumulator } from "@commonfabric/memory/v2/wire-accounting";
import type { MiddlewareHandler } from "@hono/hono";

const BASE = "/api/storage/memory/wire-accounting";
const TEXT_ENCODER = new TextEncoder();

export type MemoryWireAccountingRouteOptions = {
  accumulator?: MemoryWireAccountingAccumulator;
  token: string;
  env: string;
};

function bearerToken(authorization: string | null): string | undefined {
  if (authorization === null) return undefined;
  const trimmed = authorization.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (match === null) return undefined;
  const token = match[1].trim();
  return token.length === 0 ? undefined : token;
}

function tokenEquals(actual: string, expected: string): boolean {
  const actualBytes = TEXT_ENCODER.encode(actual);
  const expectedBytes = TEXT_ENCODER.encode(expected);
  let diff = actualBytes.length ^ expectedBytes.length;
  const length = Math.max(actualBytes.length, expectedBytes.length);
  for (let i = 0; i < length; i++) {
    diff |= (actualBytes[i] ?? 0) ^ (expectedBytes[i] ?? 0);
  }
  return diff === 0;
}

export function createMemoryWireAccountingRouter(
  options: MemoryWireAccountingRouteOptions,
) {
  const router = createRouter();
  const expectedToken = options.token.trim();
  if (
    !isMemoryWireAccountingEnabled({
      token: options.token,
      env: options.env,
    }) || options.accumulator === undefined
  ) {
    const notFound: MiddlewareHandler<AppBindings> = (c) =>
      Promise.resolve(c.notFound());
    router.use(BASE, notFound);
    router.use(`${BASE}/*`, notFound);
    return router;
  }
  const accumulator = options.accumulator;

  const requireAccess: MiddlewareHandler<AppBindings> = async (c, next) => {
    const actual = bearerToken(c.req.header("authorization") ?? null);
    if (actual === undefined || !tokenEquals(actual, expectedToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };

  router.use(BASE, requireAccess);
  router.use(`${BASE}/*`, requireAccess);

  router.post(`${BASE}/start`, (c) => {
    accumulator.start();
    return c.json({ ok: true });
  });

  router.post(`${BASE}/stop`, (c) => {
    return c.json(accumulator.stop());
  });

  return router;
}
