import { createRouter } from "@/lib/create-app.ts";

import * as handlers from "./health.handlers.ts";
import * as routes from "./health.routes.ts";

const router = createRouter()
  .openapi(routes.index, handlers.index)
  .openapi(routes.llm, handlers.llm);

export default router;
