import { cors } from "@hono/hono/cors";
import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import * as Path from "@std/path";
import * as Service from "./lib.ts";

// Ensure state directory exists
const url = new URL("state", Path.toFileUrl(Deno.cwd()));
const store = await Service.open({ store: { url } });

const app = new Hono<{}>();

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

app.put("/state/:replica/:entity", async context => {
  const replica = context.req.param("replica");
  const entity = context.req.param("entity");
});

app.get("/state/:replica/:entity", async context => {
  const replica = context.req.param("replica");
  const entity = context.req.param("entity");
});
