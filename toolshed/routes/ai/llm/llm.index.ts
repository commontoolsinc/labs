import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./llm.handlers.ts";
import * as routes from "./llm.routes.ts";
import env from "@/env.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter()
  .openapi(routes.getModels, handlers.getModels)
  .openapi(routes.generateText, handlers.generateText)
  .openapi(routes.feedback, handlers.submitFeedback);

router.use(
  "/api/ai/llm/*",
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
