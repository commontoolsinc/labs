import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import env from "@/env.ts";
import { buildInfo } from "@/lib/build-info.ts";
import { identity } from "@/lib/identity.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { IndexRoute } from "./meta.routes.ts";

const SERVER_DID = identity.did();
// Operator-set TOOLSHED_GIT_SHA wins over the build-baked SHA so that a
// hot-patched binary can be re-attested without a rebuild. Same precedence
// as `computeGitFingerprint` in the compilation cache.
const GIT_SHA = env.TOOLSHED_GIT_SHA ?? buildInfo.commitSha ?? null;

export const MetaResponseSchema = z.object({
  did: z.string(),
  gitSha: z.string().nullable(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: MetaResponse = {
    did: SERVER_DID,
    gitSha: GIT_SHA,
  };
  return c.json(response, HttpStatusCodes.OK);
};
