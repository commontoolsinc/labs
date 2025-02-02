import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./llm.handlers.ts";
import * as routes from "./llm.routes.ts";
import { register as registerPhoenixOtel } from "./instrumentation.ts";
import env from "@/env.ts";

if (env.CTTS_AI_LLM_PHOENIX_PROJECT) {
  registerPhoenixOtel();
}

const router = createRouter()
  .openapi(routes.getModels, handlers.getModels)
  .openapi(routes.generateText, handlers.generateText);

export default router;
