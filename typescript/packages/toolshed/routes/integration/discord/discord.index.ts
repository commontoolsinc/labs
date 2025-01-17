import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./discord.handlers.ts";
import * as routes from "./discord.routes.ts";

const router = createRouter().openapi(routes.sendMessage, handlers.sendMessage);

export default router;
