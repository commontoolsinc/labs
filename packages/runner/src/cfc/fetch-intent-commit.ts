import type { Runtime } from "../runtime.ts";
import type { MemorySpace } from "../storage/interface.ts";
import type { NormalizedFetchDataInputs } from "../builtins/fetch-request.ts";
import { deriveCfcFetchRequestSemantics } from "./fetch-request-semantics.ts";
import { intentRequestSemanticsMatch } from "./intent-binding.ts";
import {
  type CfcIntentCommitResult,
  commitCfcIntentWithRetries,
  type CommitCfcIntentWithRetriesOptions,
} from "./intent-commit.ts";
import type { CfcIntentOnce } from "./intent-refinement.ts";

export interface CommitCfcFetchIntentWithRetriesOptions
  extends CommitCfcIntentWithRetriesOptions {
  readonly endpoint?: string;
}

export function commitCfcFetchIntentWithRetries<T>(
  runtime: Runtime,
  space: MemorySpace,
  intent: CfcIntentOnce<T>,
  inputs: NormalizedFetchDataInputs,
  commitActionForAttempt: (
    attemptNumber: number,
  ) => Promise<CfcIntentCommitResult>,
  options: CommitCfcFetchIntentWithRetriesOptions = {},
): Promise<CfcIntentCommitResult> {
  const semantics = deriveCfcFetchRequestSemantics(inputs, {
    endpoint: options.endpoint,
  });
  if (!semantics || !intentRequestSemanticsMatch(intent, semantics)) {
    return Promise.resolve({
      success: false,
      error: "intent_binding_mismatch",
    });
  }

  return commitCfcIntentWithRetries(
    runtime,
    space,
    intent,
    commitActionForAttempt,
    {
      now: options.now,
    },
  );
}
