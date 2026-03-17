import type { NormalizedFetchDataInputs } from "../builtins/fetch-request.ts";

function hasTokenOutsideAuthorizationHeader(
  headers: Record<string, string> | undefined,
  token: string,
): boolean {
  if (!headers) {
    return false;
  }
  return Object.entries(headers).some(([key, value]) =>
    key.toLowerCase() !== "authorization" && value === token
  );
}

export function fetchAuthorizationHeaderPlacementAllowed(
  inputs: NormalizedFetchDataInputs,
  token: string,
): boolean {
  const authorization = inputs.options?.headers?.Authorization ??
    inputs.options?.headers?.authorization;
  if (authorization !== token) {
    return false;
  }
  if (!inputs.url) {
    return false;
  }

  if (hasTokenOutsideAuthorizationHeader(inputs.options?.headers, token)) {
    return false;
  }

  const url = new URL(inputs.url);
  if ([...url.searchParams.values()].some((value) => value === token)) {
    return false;
  }

  return !inputs.options?.body?.includes(token);
}
