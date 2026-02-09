import { createRouter } from "@/lib/create-app.ts";
import * as routes from "./memory.routes.ts";
import * as handlers from "./memory.handlers.ts";
import { handleV2WebSocket } from "./v2-handler.ts";

const router = createRouter();

const Router = router
  .openapi(routes.transact, handlers.transact)
  .openapi(routes.query, handlers.query)
  .openapi(routes.subscribe, handlers.subscribe)
  .get("/api/storage/memory/v2", (c) => handleV2WebSocket(c));

export default Router;
