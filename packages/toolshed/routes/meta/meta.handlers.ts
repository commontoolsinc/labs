import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { resolveGitSha, shellServerExecutionDefine } from "@/lib/build-info.ts";
import { identity } from "@/lib/identity.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { IndexRoute } from "./meta.routes.ts";

const SERVER_DID = identity.did();
const GIT_SHA = resolveGitSha();

export const MetaResponseSchema = z.object({
  did: z.string(),
  gitSha: z.string().nullable(),
  // The server-execution v2 posture the binary's browser shell was BUILT
  // with (the raw `EXPERIMENTAL_SERVER_EXECUTION` build define: "true",
  // "false", or null when unset — the shell then follows the first-party
  // default; null in a source run too). Build provenance like `gitSha`,
  // read from the compiled marker; CI's server-execution lanes assert on
  // it (docs/specs/server-side-execution/testing.md §2).
  shellServerExecutionDefine: z.string().nullable(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: MetaResponse = {
    did: SERVER_DID,
    gitSha: GIT_SHA,
    shellServerExecutionDefine,
  };
  return c.json(response, HttpStatusCodes.OK);
};
