import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "@/routes/integrations/discord/discord.handlers.ts";
import * as routes from "@/routes/integrations/discord/discord.routes.ts";
import { cors } from "@hono/hono/cors";
const router = createRouter().openapi(routes.sendMessage, handlers.sendMessage);

router.use(
  "/api/integrations/discord/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache"],
    maxAge: 3600,
    credentials: true,
  }),
);

export default router;
