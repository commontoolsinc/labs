import { createRouter } from "@/lib/create-app.ts";
import * as routes from "./new.routes.ts";
import * as handlers from "./new.handlers.ts";

const router = createRouter();

const base = "/api/storage/new/v1" as const;
router.openapi(
  { ...routes.heads, path: `${base}${routes.heads.path}` },
  handlers.heads,
);
router.openapi({ ...routes.tx, path: `${base}${routes.tx.path}` }, handlers.tx);
router.openapi(
  { ...routes.pit, path: `${base}${routes.pit.path}` },
  handlers.pit,
);
router.openapi(
  { ...routes.query, path: `${base}${routes.query.path}` },
  handlers.query,
);
router.openapi(
  { ...routes.snapshot, path: `${base}${routes.snapshot.path}` },
  handlers.snapshot,
);
router.openapi(
  { ...routes.mergeInto, path: `${base}${routes.mergeInto.path}` },
  handlers.mergeInto,
);

// Non-OpenAPI WebSocket endpoint
router.get(`${base}/:spaceId/ws`, handlers.wsHandler);

export default router;
