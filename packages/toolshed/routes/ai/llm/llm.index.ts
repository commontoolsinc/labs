import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./llm.handlers.ts";
import * as routes from "./llm.routes.ts";
import env from "@/env.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter();

router.use(
  "/api/ai/llm/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache", "x-ct-llm-trace-id"],
    maxAge: 3600,
    credentials: true,
  }),
);

router
  .openapi(routes.getModels, handlers.getModels)
  .openapi(routes.generateText, handlers.generateText)
  .openapi(routes.feedback, handlers.submitFeedback)
  .openapi(routes.generateObject, handlers.generateObject);

export default router;
