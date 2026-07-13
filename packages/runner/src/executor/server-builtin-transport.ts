import { fetchPinnedHttp } from "@commonfabric/utils/pinned-http-fetch";
import { isProtectedToolshedFirstPartyRoute } from "../toolshed-http-auth.ts";
import {
  type AuthorizedServerBuiltinRequest,
  type ServerBuiltinBrokerContext,
  ServerBuiltinUnservedError,
} from "./server-builtin-channel.ts";
import {
  createServerBuiltinEgressBroker,
  type ServerBuiltinFetchBroker,
  type ServerBuiltinHttpTransport,
  type ServerBuiltinTransportRequest,
} from "./server-builtin-egress.ts";

export interface CreateDefaultServerBuiltinBrokerOptions {
  readonly servingOrigin: URL;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly resolveDns?: typeof Deno.resolveDns;
  readonly pinnedFetch?: typeof fetchPinnedHttp;
}

/** Production egress broker: ambient fetch only for the trusted serving host. */
export function createDefaultServerBuiltinBroker(
  options: CreateDefaultServerBuiltinBrokerOptions,
): ServerBuiltinFetchBroker {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const pinnedFetch = options.pinnedFetch ?? fetchPinnedHttp;
  const resolveDns = options.resolveDns ?? Deno.resolveDns;
  const transport: ServerBuiltinHttpTransport = {
    request: (request) =>
      request.trustedServingOrigin
        ? fetchTrustedServingOrigin(fetchImpl, request)
        : fetchExternalPinned(pinnedFetch, request),
  };
  return createServerBuiltinEgressBroker({
    servingOrigin: options.servingOrigin,
    resolveHostAddresses: async (hostname) => {
      const resolutions = await Promise.allSettled([
        resolveDns(hostname, "A"),
        resolveDns(hostname, "AAAA"),
      ]);
      const addresses = resolutions.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      );
      if (addresses.length === 0) {
        const reasons = resolutions.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        throw new AggregateError(
          reasons,
          `DNS resolution failed for ${hostname}`,
        );
      }
      return addresses;
    },
    transport,
  });
}

/**
 * User credentials never cross the Worker boundary. Until delegated signing
 * exists, protected first-party routes remain client-primary/fail closed.
 */
export function authorizeDefaultServerBuiltinRequest(
  request: AuthorizedServerBuiltinRequest,
  context: ServerBuiltinBrokerContext,
): void {
  const target = new URL(request.fetch.url, context.servingOrigin);
  if (
    target.origin === context.servingOrigin.origin &&
    isProtectedToolshedFirstPartyRoute(
      target,
      (request.fetch.method ?? "GET").trim(),
    )
  ) {
    throw new ServerBuiltinUnservedError(
      "server-builtin-authorization-denied",
      "protected first-party builtin request requires delegated user signing",
    );
  }
}

function fetchTrustedServingOrigin(
  fetchImpl: typeof globalThis.fetch,
  request: ServerBuiltinTransportRequest,
): Promise<Response> {
  return fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined
      ? {
        body: request.body instanceof Uint8Array
          ? new Uint8Array(request.body).buffer
          : request.body,
      }
      : {}),
    signal: request.signal,
    redirect: "manual",
    credentials: "omit",
  });
}

async function fetchExternalPinned(
  pinnedFetch: typeof fetchPinnedHttp,
  request: ServerBuiltinTransportRequest,
): Promise<Response> {
  const errors: unknown[] = [];
  for (const address of request.resolvedAddresses) {
    try {
      return await pinnedFetch(request.url, address, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: request.signal,
        errorLabel: "server builtin",
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      errors.push(error);
    }
  }
  throw new AggregateError(
    errors,
    `server builtin could not connect to ${request.url.hostname}`,
  );
}
