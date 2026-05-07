import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { resolveGitSha } from "@/lib/build-info.ts";
import { identity } from "@/lib/identity.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { IndexRoute } from "./meta.routes.ts";

const SERVER_DID = identity.did();
const GIT_SHA = resolveGitSha();

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
