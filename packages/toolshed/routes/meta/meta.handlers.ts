import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { identity } from "@/lib/identity.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { IndexRoute } from "./meta.routes.ts";
import { runtime } from "@/index.ts";

const SERVER_DID = identity.did();

const ExperimentalSchema = z.object({
  richStorableValues: z.boolean(),
  storableProtocol: z.boolean(),
  unifiedJsonEncoding: z.boolean(),
});

export const MetaResponseSchema = z.object({
  did: z.string(),
  experimental: ExperimentalSchema.optional(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: MetaResponse = {
    did: SERVER_DID,
    experimental: runtime.experimental,
  };
  return c.json(response, HttpStatusCodes.OK);
};
