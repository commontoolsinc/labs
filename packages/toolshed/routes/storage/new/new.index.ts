import { createRouter } from "@/lib/create-app.ts";
import * as routes from "./new.routes.ts";
import * as handlers from "./new.handlers.ts";

const router = createRouter();

const Router = router
  .openapi(routes.heads, handlers.heads)
  .openapi(routes.tx, handlers.tx)
  .openapi(routes.pit, handlers.pit)
  .openapi(routes.query, handlers.query)
  .openapi(routes.snapshot, handlers.snapshot)
  .openapi(routes.mergeInto, handlers.mergeInto)
  .get("/spaces/:spaceId/subscribe", handlers.wsHandler);

export default Router;
