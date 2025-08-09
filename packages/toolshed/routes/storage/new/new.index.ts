import { createRouter } from "@/lib/create-app.ts";
import * as routes from "./new.routes.ts";
import * as handlers from "./new.handlers.ts";

const router = createRouter();

const Router = router
  .openapi(routes.createDoc, handlers.createDoc)
  .openapi(routes.heads, handlers.heads)
  .openapi(routes.tx, handlers.tx);

export default Router;
