import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./voice.handlers.ts";
import * as routes from "./voice.routes.ts";
import { cors } from "@hono/hono/cors";
const router = createRouter()
  .openapi(routes.transcribeVoice, handlers.transcribeVoice);

router.use(
  "/api/ai/voice/*",
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
