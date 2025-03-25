import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { identity } from "@/lib/identity.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { IndexRoute } from "./meta.routes.ts";

const SERVER_DID = identity.did();

export const MetaResponseSchema = z.object({
  did: z.string(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: MetaResponse = {
    did: SERVER_DID,
  };
  return c.json(response, HttpStatusCodes.OK);
};
