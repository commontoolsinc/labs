import type { LLMClientRequestOptions } from "@commonfabric/llm";
import { createInternalLLMBrokerRequestOptions } from "@commonfabric/llm/internal";
import type { MemorySpace } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import { getPatternEnvironment } from "../builder/env.ts";

/** The LLM builtins that have a server broker route (R5). */
export type LLMServerBuiltinId =
  | "llm"
  | "generateText"
  | "generateObject"
  | "llmDialog";

/**
 * Resolve the LLM client options for one model call.
 *
 * Its own module rather than a member of `llm.ts` because `llmDialog` needs it
 * too and `llm.ts` already imports `llm-dialog.ts` (`llmToolExecutionHelpers`) —
 * putting it there would close an import cycle. Every LLM builtin must route
 * through here: server-side the call has to reach
 * `runtime.fetchBuiltin(<id>, …)`, because the executor Worker's
 * `fetch: denyExternalBuiltinFetch` never sees a request the module-level
 * `LLMClient` makes through `globalThis.fetch`.
 */
export function llmClientOptions(
  runtime: Runtime,
  space: MemorySpace,
  serverBuiltinId?: LLMServerBuiltinId,
): LLMClientRequestOptions | undefined {
  const mappedLlmHost = runtime.mappedHostFor(space);
  if (!runtime.hasServerBuiltinFetch()) {
    return mappedLlmHost
      ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
      : undefined;
  }
  if (serverBuiltinId === undefined) {
    throw new Error("unsupported LLM builtin has no server broker route");
  }
  const endpoint = new URL(
    "/api/ai/llm",
    mappedLlmHost ?? getPatternEnvironment().apiUrl,
  );
  return createInternalLLMBrokerRequestOptions({
    endpoint,
    fetch: (input, init) => {
      const target = input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : input, endpoint);
      return runtime.fetchBuiltin(
        serverBuiltinId,
        `${target.pathname}${target.search}`,
        target,
        init,
      );
    },
  });
}
