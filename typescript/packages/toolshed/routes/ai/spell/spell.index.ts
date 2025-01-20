import { createRouter } from "@/lib/create-app.ts";

import * as handlers from "./spell.handlers.ts";
import * as routes from "./spell.routes.ts";

const router = createRouter()
  .openapi(routes.processText, handlers.processText)
  .openapi(routes.processSchema, handlers.processSchema);

export default router;
