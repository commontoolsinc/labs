import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { cache as staticCache } from "@commontools/static";
import { getMimeType } from "@/lib/mime-type.ts";

const router = createRouter();

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
  const buffer = await staticCache.get(reqPath);
  const mimeType = getMimeType(reqPath);
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
    },
  });
});

export default router;
