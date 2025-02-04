import { createRouter } from "@/lib/create-app.ts";
import * as routes from "./memory.routes.ts";
import * as handlers from "./memory.handlers.ts";
import { cors } from "hono/cors";

const router = createRouter();
router.use(cors());

const Router = router
  .openapi(routes.transact, handlers.transact)
  .openapi(routes.subscribe, handlers.subscribe);

export default Router;
