import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "@/routes/integrations/discord/discord.handlers.ts";
import * as routes from "@/routes/integrations/discord/discord.routes.ts";

const router = createRouter().openapi(routes.sendMessage, handlers.sendMessage);

export default router;
