import type { CfcIntentOnce } from "./intent-refinement.ts";

export interface CfcIntentRequestSemantics {
  readonly audience: string;
  readonly endpoint: string;
  readonly payloadDigest?: string;
  readonly idempotencyKey?: string;
}

export function intentRequestSemanticsMatch<T>(
  intent: Pick<
    CfcIntentOnce<T>,
    "audience" | "endpoint" | "payloadDigest" | "idempotencyKey"
  >,
  semantics: CfcIntentRequestSemantics,
): boolean {
  return semantics.audience === intent.audience &&
    semantics.endpoint === intent.endpoint &&
    semantics.payloadDigest === intent.payloadDigest &&
    semantics.idempotencyKey === intent.idempotencyKey;
}
