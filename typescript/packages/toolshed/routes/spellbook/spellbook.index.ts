import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./spellbook.handlers.ts";
import * as routes from "./spellbook.routes.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter();

router.use(
  "/api/spellbook/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache"],
    maxAge: 3600,
    credentials: true,
  }),
);

const Router = router
  .openapi(routes.listSpells, handlers.listSpellsHandler)
  .openapi(routes.getSpell, handlers.getSpellHandler)
  .openapi(routes.createSpell, handlers.createSpellHandler)
  .openapi(routes.toggleLike, handlers.toggleLikeHandler)
  .openapi(routes.createComment, handlers.createCommentHandler)
  .openapi(routes.shareSpell, handlers.shareSpellHandler)
  .openapi(routes.trackRun, handlers.trackRunHandler)
  .openapi(routes.deleteSpell, handlers.deleteSpellHandler);

export default Router;
