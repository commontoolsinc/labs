import { createRouter } from "@/lib/create-app.ts";
import * as routes from "./v2-memory.routes.ts";
import * as handlers from "./v2-memory.handlers.ts";

const router = createRouter();

const Router = router
  .openapi(routes.transact, handlers.transact)
  .openapi(routes.query, handlers.query)
  .openapi(routes.subscribe, handlers.subscribe);

export default Router;
