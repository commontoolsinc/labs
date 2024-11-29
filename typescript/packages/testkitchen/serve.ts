import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";

const app = new Hono();

app.use("/*", cors());
app.use("*", serveStatic({ root: "./static" }));

export default app;
