import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./img.handlers.ts";
import * as routes from "./img.routes.ts";

const router = createRouter()
  .openapi(routes.generateImage, handlers.generateImage)
  .openapi(routes.generateImageAdvanced, handlers.generateImageAdvanced);

export default router;
