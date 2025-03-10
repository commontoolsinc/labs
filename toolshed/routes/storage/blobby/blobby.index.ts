// NOTE(jake): The redis client is javascript, and so the types are weird.
// To get things working, we need to include this special reference thing.
/// <reference types="npm:@types/node" />

import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./blobby.handlers.ts";
import * as routes from "./blobby.routes.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter();

router.use(
  "/api/storage/blobby/*",
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
  .openapi(routes.uploadBlob, handlers.uploadBlobHandler)
  .openapi(routes.getBlob, handlers.getBlobHandler)
  .openapi(routes.getBlobPath, handlers.getBlobPathHandler)
  .openapi(routes.listBlobs, handlers.listBlobsHandler)
  .openapi(routes.deleteBlob, handlers.deleteBlobHandler);

export default Router;
