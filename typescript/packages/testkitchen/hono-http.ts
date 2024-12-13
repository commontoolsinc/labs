import { cors } from "@hono/hono/cors";
import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { join } from "@std/path";

export function startTempServer(): number {
  const app = new Hono();

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Length", "X-Kuma-Revision"],
      maxAge: 600,
      credentials: true,
    }),
  );

  app.get('/tmp/*', async (c) => {
    const path = c.req.url.split('/tmp/')[1];
    try {
      const content = await Deno.readFile(join('tmp', path));
      c.header('Content-Type', 'application/typescript');
      return c.body(content);
    } catch {
      return c.notFound();
    }
  });

  const port = Math.floor(Math.random() * (65535 - 49152) + 49152);
  
  Deno.serve({ port }, app.fetch);
  
  return port;
}
