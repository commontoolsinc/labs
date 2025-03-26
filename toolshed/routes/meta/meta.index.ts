import { createRouter } from "@/lib/create-app.ts";

import * as handlers from "./meta.handlers.ts";
import * as routes from "./meta.routes.ts";

const router = createRouter()
  .openapi(routes.index, handlers.index);

export default router;
