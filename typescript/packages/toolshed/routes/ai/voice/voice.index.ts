import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./voice.handlers.ts";
import * as routes from "./voice.routes.ts";

const router = createRouter()
  .openapi(routes.transcribeVoice, handlers.transcribeVoice);

export default router;
