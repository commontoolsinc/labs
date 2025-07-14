import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { StaticCache } from "@commontools/static";
import { getMimeType } from "@/lib/mime-type.ts";

const router = createRouter();

// Notably this uses a different cache
// than the runtime that runs in this context, negigible
// cost of not incorporating the runtime here.
const cache = new StaticCache();

router.use(
  "*",
  // Setup CORS so that modules imported from sandboxed null-origin iframe are rejected.
  // Specifically we need this to be able to import ./jumble/public/module/charm/sandbox/bootstrap.js
  // from sandboxed iframe
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

router.get("/static/*", async (c) => {
  const reqPath = c.req.path.substring("/static/".length);
  const buffer = await cache.get(reqPath);
  const mimeType = getMimeType(reqPath);
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
    },
  });
});

export default router;
