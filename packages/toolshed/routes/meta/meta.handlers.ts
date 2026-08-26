import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { resolveGitSha, shellServerExecutionDefine } from "@/lib/build-info.ts";
import { cfcPosture } from "@/lib/cfc-posture.ts";
import { experimentalPosture } from "@/lib/experimental-posture.ts";
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
  // The experimental-flag posture this server RUNS AT — its own Runtime's
  // resolved flags, with the ones a serving runtime forces applied over them
  // — which a client not built alongside it adopts rather than being
  // configured to match by hand (docs/development/EXPERIMENTAL_OPTIONS.md).
  // An omitted flag means this server said nothing about it, and `null` means
  // it has no Runtime yet; a client keeps its built-in default for either.
  experimental: z.record(z.string(), z.boolean()).nullable(),
  // The CFC posture this server's Runtime resolved — the enforcement dials,
  // the policy-snapshot digest, and which sinks carry a confidentiality
  // ceiling — so a deployment's enforcement is readable rather than
  // indistinguishable from the default (lib/cfc-posture.ts). `null` means no
  // Runtime yet.
  cfc: z.object({
    enforcementMode: z.string(),
    flowLabels: z.string(),
    writeFloor: z.string(),
    triggerReadGating: z.boolean(),
    decomposedEnvelopes: z.boolean(),
    policyEvaluation: z.string(),
    labelMetadataProtection: z.string(),
    declaredMonotonicity: z.string(),
    policyDigest: z.string().nullable(),
    sinkCeilings: z.array(z.string()),
  }).nullable(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: MetaResponse = {
    did: SERVER_DID,
    gitSha: GIT_SHA,
    shellServerExecutionDefine,
    experimental: experimentalPosture(),
    cfc: cfcPosture(),
  };
  return c.json(response, HttpStatusCodes.OK);
};
