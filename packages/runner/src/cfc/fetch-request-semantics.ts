import type { NormalizedFetchDataInputs } from "../builtins/fetch-request.ts";
import type { CfcIntentRequestSemantics } from "./intent-binding.ts";
import { computeCfcIntentPayloadDigest } from "./intent-refinement.ts";

export interface DeriveCfcFetchRequestSemanticsOptions {
  readonly endpoint?: string;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const match = Object.entries(headers).find(([key]) =>
    key.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
  );
  return match?.[1];
}

export function deriveCfcFetchRequestSemantics(
  inputs: NormalizedFetchDataInputs,
  options: DeriveCfcFetchRequestSemanticsOptions = {},
): CfcIntentRequestSemantics | undefined {
  if (!inputs.url) {
    return undefined;
  }

  const url = new URL(inputs.url);
  const method = (inputs.options?.method ?? "GET").toUpperCase();
  return {
    audience: url.origin,
    endpoint: options.endpoint ?? `${method} ${url.pathname}`,
    payloadDigest: inputs.options?.body === undefined
      ? undefined
      : computeCfcIntentPayloadDigest(inputs.options.body),
    idempotencyKey: headerValue(
      inputs.options?.headers,
      "X-Idempotency-Key",
    ),
  };
}
