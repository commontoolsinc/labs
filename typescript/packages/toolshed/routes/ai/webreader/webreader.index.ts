import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./webreader.handlers.ts";
import * as routes from "./webreader.routes.ts";

const router = createRouter()
  .openapi(routes.readWebPage, handlers.readWebPage)
  .openapi(routes.readWebPageAdvanced, handlers.readWebPageAdvanced);

export default router;
