import { OpenAPIHono } from "@hono/zod-openapi";
import { Context } from "hono";
import { notFound, serveEmojiFavicon } from "stoker/middlewares";
import { defaultHook } from "stoker/openapi";
import { pinoLogger } from "@/middlewares/pino-logger.ts";
import { sentry } from "@hono/sentry";
import env from "@/env.ts";
import type { AppBindings, AppOpenAPI } from "@/lib/types.ts";

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

export function onError(err: unknown, c: Context) {
  const logger = c.get("logger");
  logger.error("Server Error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
}

export default function createApp() {
  const app = createRouter();

  app.use("*", sentry({ dsn: env.SENTRY_DSN }));

  app.use(serveEmojiFavicon("🪓"));
  app.use(pinoLogger());

  app.notFound(notFound);
  app.onError(onError);
  return app;
}

export function createTestApp<R extends AppOpenAPI>(router: R) {
  return createApp().route("/", router);
}
