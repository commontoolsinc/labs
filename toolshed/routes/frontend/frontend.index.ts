import { exists } from "@std/fs";
import * as path from "@std/path";
import { createRouter } from "@/lib/create-app.ts";
import { applyProxy } from "./frontend.proxy.ts";
import { applyStatic } from "./frontend.static.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter();

router.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

const dirname = import.meta?.dirname;
if (!dirname) {
  throw new Error("File does not have dirname in toolshed.");
}
const projectRoot = path.join(dirname, "..", "..");
const COMPILED = await exists(path.join(projectRoot, "COMPILED"));

// If this was compiled via `deno compile`, serve
// bundled static frontend.
if (COMPILED) {
  console.log("Applying STATIC frontend");
  applyStatic(projectRoot, router);
} else {
  console.log("Applying PROXY frontend");
  applyProxy(router);
}

export default router;
