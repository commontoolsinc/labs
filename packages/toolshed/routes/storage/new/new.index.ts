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

// UCAN compatibility alias routes used by integration tests
router.get(`${base}/:space/heads/:docId`, handlers.headsSimple);
router.post(`${base}/:space/tx`, handlers.txSimple);
router.get(`${base}/:space/ws`, handlers.wsAuthProbe);

// Unprefixed aliases for integration tests mounting this router at '/'
router.get(
  `/spaces/:spaceId/docs/:docId/branches/:branchId/heads`,
  handlers.heads,
);
router.post(`/spaces/:spaceId/tx`, handlers.tx);
router.get(`/spaces/:spaceId/pit`, handlers.pit);
router.post(`/spaces/:spaceId/query`, handlers.query);
router.get(
  `/spaces/:spaceId/snapshots/:docId/:branchId/:seq`,
  handlers.snapshot,
);
router.post(
  `/spaces/:spaceId/docs/:docId/branches/:from/merge-into/:to`,
  handlers.mergeInto,
);
router.get(`/:spaceId/ws`, handlers.wsHandler);
router.get(`/spaces/:spaceId/subscribe`, (c) => {
  const upgrade = c.req.header("upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    return handlers.wsHandler(c);
  }
  // Non-upgrade probe succeeds for tests
  return c.text("ok");
});

export default router;
