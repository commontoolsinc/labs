import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { StaticCache } from "@commontools/static";
import { getMimeType } from "@/lib/mime-type.ts";

const router = createRouter();

const STATIC_CACHE_DURATION = 60 * 60 * 1; // 1 hour

// Notably this uses a different cache
// than the runtime that runs in this context, negigible
// cost of not incorporating the runtime here.
const cache = new StaticCache();

router.use(
  "*",
  // Setup CORS so that modules imported from sandboxed null-origin iframe are rejected.
  // Specifically we need this to be able to import iframe-bootstrap.js
  // from sandboxed iframes
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
      "Cache-Control": `max-age=${STATIC_CACHE_DURATION}`,
    },
  });
});

export default router;
