import type { BranchName, ExecutionClaim } from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  isServerExecutableBuiltinId,
  serverBuiltinImplementationHash,
  type ServerExecutableBuiltinId,
} from "../builtins/server-execution.ts";
import type {
  ServerBuiltinFetchBroker,
  ServerBuiltinFetchRequest,
} from "./server-builtin-egress.ts";

export interface ServerBuiltinBrokerContext {
  readonly space: MemorySpace;
  readonly branch: BranchName;
  readonly leaseGeneration: number;
  readonly onBehalfOf: string;
  readonly servingOrigin: URL;
}

export interface AuthorizedServerBuiltinRequest {
  readonly builtinId: ServerExecutableBuiltinId;
  readonly claim: ExecutionClaim;
  readonly fetch: Omit<ServerBuiltinFetchRequest, "signal">;
}

export interface CreateServerBuiltinBrokerHostOptions {
  readonly port: MessagePort;
  readonly context: ServerBuiltinBrokerContext;
  readonly broker: ServerBuiltinFetchBroker;
  readonly isClaimLive: (
    claim: ExecutionClaim,
  ) => boolean | Promise<boolean>;
  readonly authorize?: (
    request: AuthorizedServerBuiltinRequest,
    context: ServerBuiltinBrokerContext,
  ) => void | Promise<void>;
}

export interface ServerBuiltinBrokerHost {
  dispose(): void;
}

export interface CreateServerBuiltinBrokerClientOptions {
  readonly port: MessagePort;
  readonly claimForRequest: (
    builtinId: ServerExecutableBuiltinId,
  ) => ExecutionClaim | undefined;
}

export interface ServerBuiltinBrokerClient {
  fetch(
    builtinId: ServerExecutableBuiltinId,
    rawUrl: string,
    init?: RequestInit,
  ): Promise<Response>;
  dispose(): void;
}

interface FetchWireRequest {
  readonly type: "server-builtin.fetch";
  readonly requestId: number;
  readonly builtinId: ServerExecutableBuiltinId;
  readonly claim: ExecutionClaim;
  readonly url: string;
  readonly method?: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: string | Uint8Array;
}

interface CancelWireRequest {
  readonly type: "server-builtin.cancel";
  readonly requestId: number;
}

type FetchWireResponse =
  | {
    readonly type: "server-builtin.fetch-result";
    readonly requestId: number;
    readonly ok: true;
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: Uint8Array;
    readonly finalUrl: string;
    readonly redirectCount: number;
  }
  | {
    readonly type: "server-builtin.fetch-result";
    readonly requestId: number;
    readonly ok: false;
    readonly error: {
      readonly name: string;
      readonly message: string;
      readonly code?: string;
    };
  };

const AUTHORITY_FIELDS = [
  "onBehalfOf",
  "servingOrigin",
  "leaseGeneration",
  "actor",
] as const;

export function createServerBuiltinBrokerHost(
  options: CreateServerBuiltinBrokerHostOptions,
): ServerBuiltinBrokerHost {
  const inflight = new Map<number, AbortController>();
  let disposed = false;

  const respond = (response: FetchWireResponse): void => {
    if (!disposed) options.port.postMessage(response);
  };

  const handleFetch = async (value: unknown): Promise<void> => {
    const requestId = wireRequestId(value);
    try {
      const request = parseFetchWireRequest(value);
      validateClaimForRequest(request, options.context);
      if (!await options.isClaimLive(request.claim)) {
        throw new Error("server builtin request requires an exact live claim");
      }
      const controller = new AbortController();
      inflight.set(request.requestId, controller);
      const fetchRequest = {
        url: request.url,
        ...(request.method !== undefined ? { method: request.method } : {}),
        headers: request.headers.map(([name, headerValue]) =>
          [
            name,
            headerValue,
          ] as [string, string]
        ),
        ...(request.body !== undefined
          ? {
            body: request.body instanceof Uint8Array
              ? request.body.slice()
              : request.body,
          }
          : {}),
      } satisfies Omit<ServerBuiltinFetchRequest, "signal">;
      const authorized = {
        builtinId: request.builtinId,
        claim: request.claim,
        fetch: fetchRequest,
      } satisfies AuthorizedServerBuiltinRequest;
      await options.authorize?.(authorized, options.context);
      const result = await options.broker.fetch({
        ...fetchRequest,
        signal: controller.signal,
      });
      const body = new Uint8Array(await result.response.arrayBuffer());
      respond({
        type: "server-builtin.fetch-result",
        requestId: request.requestId,
        ok: true,
        status: result.response.status,
        statusText: result.response.statusText,
        headers: [...result.response.headers.entries()],
        body,
        finalUrl: result.finalUrl.href,
        redirectCount: result.redirectCount,
      });
    } catch (error) {
      if (requestId !== undefined) {
        respond({
          type: "server-builtin.fetch-result",
          requestId,
          ok: false,
          error: serializeError(error),
        });
      }
    } finally {
      if (requestId !== undefined) inflight.delete(requestId);
    }
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (disposed) return;
    const value = event.data;
    if (isCancelWireRequest(value)) {
      inflight.get(value.requestId)?.abort(
        new Error("server builtin request was cancelled"),
      );
      return;
    }
    void handleFetch(value);
  };

  options.port.addEventListener("message", onMessage);
  options.port.start();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      options.port.removeEventListener("message", onMessage);
      for (const controller of inflight.values()) {
        controller.abort(new Error("server builtin broker was disposed"));
      }
      inflight.clear();
      options.port.close();
    },
  };
}

export function createServerBuiltinBrokerClient(
  options: CreateServerBuiltinBrokerClientOptions,
): ServerBuiltinBrokerClient {
  const pending = new Map<
    number,
    {
      readonly promise: PromiseWithResolvers<Response>;
      readonly signal?: AbortSignal;
      readonly onAbort?: () => void;
    }
  >();
  let requestId = 0;
  let disposed = false;

  const onMessage = (event: MessageEvent<unknown>): void => {
    const response = parseFetchWireResponse(event.data);
    if (response === undefined) return;
    const entry = pending.get(response.requestId);
    if (entry === undefined) return;
    pending.delete(response.requestId);
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    if (!response.ok) {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      if (response.error.code !== undefined) {
        (error as Error & { code?: string }).code = response.error.code;
      }
      entry.promise.reject(error);
      return;
    }
    const result = new Response(response.body.slice(), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers.map(([name, value]) =>
        [name, value] as [string, string]
      ),
    });
    try {
      Object.defineProperty(result, "url", { value: response.finalUrl });
    } catch {
      // Response.url is informational; body/status/headers are authoritative.
    }
    entry.promise.resolve(result);
  };

  options.port.addEventListener("message", onMessage);
  options.port.start();

  return {
    fetch(builtinId, rawUrl, init = {}) {
      if (disposed) {
        return Promise.reject(new Error("server builtin broker is disposed"));
      }
      const claim = options.claimForRequest(builtinId);
      if (claim === undefined) {
        return Promise.reject(
          new Error("server builtin request has no claimed source action"),
        );
      }
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }
      const id = ++requestId;
      const promise = Promise.withResolvers<Response>();
      const onAbort = signal === undefined ? undefined : () => {
        const entry = pending.get(id);
        if (entry === undefined) return;
        pending.delete(id);
        options.port.postMessage(
          {
            type: "server-builtin.cancel",
            requestId: id,
          } satisfies CancelWireRequest,
        );
        entry.promise.reject(abortReason(signal));
      };
      pending.set(id, {
        promise,
        ...(signal !== undefined ? { signal } : {}),
        ...(onAbort !== undefined ? { onAbort } : {}),
      });
      signal?.addEventListener("abort", onAbort!, { once: true });
      try {
        options.port.postMessage(
          {
            type: "server-builtin.fetch",
            requestId: id,
            builtinId,
            claim,
            url: rawUrl,
            ...(init.method !== undefined ? { method: init.method } : {}),
            headers: [...new Headers(init.headers).entries()],
            ...wireBody(init.body),
          } satisfies FetchWireRequest,
        );
      } catch (error) {
        pending.delete(id);
        signal?.removeEventListener("abort", onAbort!);
        promise.reject(error);
      }
      return promise.promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      options.port.removeEventListener("message", onMessage);
      options.port.close();
      for (const entry of pending.values()) {
        if (entry.signal !== undefined && entry.onAbort !== undefined) {
          entry.signal.removeEventListener("abort", entry.onAbort);
        }
        entry.promise.reject(new Error("server builtin broker was disposed"));
      }
      pending.clear();
    },
  };
}

function parseFetchWireRequest(value: unknown): FetchWireRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid server builtin request");
  }
  const request = value as Record<string, unknown>;
  if (AUTHORITY_FIELDS.some((field) => field in request)) {
    throw new Error("server builtin request contains forged authority");
  }
  if (
    request.type !== "server-builtin.fetch" ||
    !isPositiveSafeInteger(request.requestId) ||
    !isServerExecutableBuiltinId(request.builtinId) ||
    !isExecutionClaim(request.claim) ||
    typeof request.url !== "string" || request.url.length === 0 ||
    (request.method !== undefined && typeof request.method !== "string") ||
    !isHeaderEntries(request.headers) ||
    (request.body !== undefined && typeof request.body !== "string" &&
      !(request.body instanceof Uint8Array))
  ) {
    throw new Error("invalid server builtin request");
  }
  return request as unknown as FetchWireRequest;
}

function validateClaimForRequest(
  request: FetchWireRequest,
  context: ServerBuiltinBrokerContext,
): void {
  const claim = request.claim;
  if (
    claim.space !== context.space || claim.branch !== context.branch ||
    claim.contextKey !== "space" || claim.actionKind !== "effect" ||
    claim.leaseGeneration !== context.leaseGeneration ||
    claim.implementationFingerprint !==
      `impl:${serverBuiltinImplementationHash(request.builtinId)}`
  ) {
    throw new Error("server builtin request claim does not match its lane");
  }
}

function parseFetchWireResponse(value: unknown): FetchWireResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const response = value as Record<string, unknown>;
  if (
    response.type !== "server-builtin.fetch-result" ||
    !isPositiveSafeInteger(response.requestId) ||
    typeof response.ok !== "boolean"
  ) {
    return undefined;
  }
  if (response.ok === false) {
    const error = response.error as Record<string, unknown> | undefined;
    return error !== undefined && typeof error.name === "string" &&
        typeof error.message === "string" &&
        (error.code === undefined || typeof error.code === "string")
      ? value as FetchWireResponse
      : undefined;
  }
  return Number.isSafeInteger(response.status) &&
      typeof response.statusText === "string" &&
      isHeaderEntries(response.headers) &&
      response.body instanceof Uint8Array &&
      typeof response.finalUrl === "string" &&
      Number.isSafeInteger(response.redirectCount)
    ? value as FetchWireResponse
    : undefined;
}

function isCancelWireRequest(value: unknown): value is CancelWireRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return request.type === "server-builtin.cancel" &&
    isPositiveSafeInteger(request.requestId);
}

function wireRequestId(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const requestId = (value as Record<string, unknown>).requestId;
  return isPositiveSafeInteger(requestId) ? requestId : undefined;
}

function isExecutionClaim(value: unknown): value is ExecutionClaim {
  if (typeof value !== "object" || value === null) return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.branch === "string" &&
    typeof claim.space === "string" && claim.contextKey === "space" &&
    typeof claim.pieceId === "string" && typeof claim.actionId === "string" &&
    claim.actionKind === "effect" &&
    typeof claim.implementationFingerprint === "string" &&
    typeof claim.runtimeFingerprint === "string" &&
    isPositiveSafeInteger(claim.leaseGeneration) &&
    isPositiveSafeInteger(claim.claimGeneration) &&
    typeof claim.expiresAt === "number" && Number.isFinite(claim.expiresAt);
}

function isHeaderEntries(
  value: unknown,
): value is readonly (readonly [string, string])[] {
  return Array.isArray(value) &&
    value.every((entry) =>
      Array.isArray(entry) && entry.length === 2 &&
      typeof entry[0] === "string" && typeof entry[1] === "string"
    );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function wireBody(body: BodyInit | null | undefined): {
  body?: string | Uint8Array;
} {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body };
  if (body instanceof Uint8Array) {
    return { body: (body as Uint8Array).slice() };
  }
  if (body instanceof ArrayBuffer) {
    return { body: new Uint8Array(body.slice(0)) };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      body: new Uint8Array(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      ),
    };
  }
  throw new TypeError(
    "server builtin broker requires a replayable string or byte body",
  );
}

function serializeError(error: unknown): {
  name: string;
  message: string;
  code?: string;
} {
  const record = typeof error === "object" && error !== null
    ? error as { name?: unknown; message?: unknown; code?: unknown }
    : undefined;
  return {
    name: typeof record?.name === "string" ? record.name : "Error",
    message: typeof record?.message === "string"
      ? record.message
      : String(error),
    ...(typeof record?.code === "string" ? { code: record.code } : {}),
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException("The operation was aborted", "AbortError");
}
