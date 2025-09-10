import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { StaticCache } from "@commontools/static";
import { getMimeType } from "@/lib/mime-type.ts";
import { compareETags, createCacheHeaders } from "@commontools/static/etag";

const router = createRouter();

// Static cache instance - separate from runtime cache
// for isolation and performance
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
  const ifNoneMatch = c.req.header("If-None-Match");

  // Get the asset with its ETag
  const { buffer, etag } = await cache.getWithETag(reqPath);

  // Check if client has matching ETag
  if (ifNoneMatch && compareETags(etag, ifNoneMatch)) {
    return new Response(null, {
      status: 304,
      headers: {
        "ETag": etag,
      },
    });
  }

  const mimeType = getMimeType(reqPath);

  // Simple caching: always validate with ETag
  const cacheHeaders = createCacheHeaders(etag);

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      ...cacheHeaders,
    },
  });
});

export default router;
