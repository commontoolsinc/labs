import { createRouter } from "@/lib/create-app.ts";
import { serveStatic } from "hono/deno";

const router = createRouter();

router.get(
  "/app/latest/*",
  serveStatic({
    root: "./lookslike-highlevel-dist",
    rewriteRequestPath: (path) => {
      // Handle root path by serving index.html
      if (path === "/app/latest" || path === "/app/latest/") {
        return "/index.html";
      }
      // Remove /app/latest prefix for all other paths
      return path.replace("/app/latest", "");
    },
  }),
);

export default router;
