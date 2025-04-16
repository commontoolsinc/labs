import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./llm.handlers.ts";
import * as routes from "./llm.routes.ts";
import { register as registerPhoenixOtel } from "./instrumentation.ts";
import env from "@/env.ts";
import { cors } from "@hono/hono/cors";

if (env.CTTS_AI_LLM_PHOENIX_PROJECT) {
  registerPhoenixOtel();
}

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
