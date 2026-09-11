// Thin transport wrappers over pattern-lifecycle.utils.ts, the shape the
// ingest-channels handlers set: the verified caller DID, the deployment's
// dependencies, and the call.

import env from "@/env.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import { serverExecutionHost } from "@/lib/server-execution.ts";
import { hostsSpaceInStore } from "@/lib/space-authority.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import { memoryEngineStoreUrl } from "@/routes/storage/memory-store-url.ts";
import type {
  InstantiateRoute,
  UploadRoute,
} from "./pattern-lifecycle.routes.ts";
import {
  type LifecycleDeps,
  processInstantiate,
  processUpload,
} from "./pattern-lifecycle.utils.ts";

const serviceDids = env.MEMORY_SERVICE_DIDS
  .split(",")
  .map((did) => did.trim())
  .filter((did) => did.length > 0);

const hostsSpace = hostsSpaceInStore(memoryEngineStoreUrl);

const deps = (logger: LifecycleDeps["logger"]): LifecycleDeps => ({
  authority: {
    runtime,
    operatorDid: identity.did(),
    serviceDids,
    hostsSpace,
    aclMode: env.MEMORY_ACL_MODE,
  },
  host: serverExecutionHost,
  serviceIdentity: identity,
  logger,
});

export const upload: AppRouteHandler<UploadRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) {
    return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
  }
  const result = await processUpload(
    deps(c.get("logger")),
    callerDid,
    c.req.valid("json"),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const instantiate: AppRouteHandler<InstantiateRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) {
    return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
  }
  const result = await processInstantiate(
    deps(c.get("logger")),
    callerDid,
    c.req.valid("json"),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};
