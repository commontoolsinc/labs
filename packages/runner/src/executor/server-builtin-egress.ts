/**
 * Host-side network policy for server-executed builtins.
 *
 * This module deliberately has no default HTTP transport. A safe external
 * transport must connect to one of `resolvedAddresses` (or provide an
 * equivalent DNS pinning guarantee); resolving here and then calling the
 * ambient `fetch()` by hostname would leave a DNS-rebinding gap. The executor
 * Worker can therefore receive a narrow broker capability without receiving
 * raw network access.
 */

export type ServerBuiltinEgressErrorCode =
  | "invalid-serving-origin"
  | "invalid-url"
  | "blocked-scheme"
  | "blocked-destination"
  | "dns-resolution-failed"
  | "invalid-method"
  | "invalid-headers"
  | "request-body-too-large"
  | "request-timeout"
  | "aborted"
  | "too-many-redirects"
  | "response-headers-too-large"
  | "response-too-large";

export class ServerBuiltinEgressError extends Error {
  readonly code: ServerBuiltinEgressErrorCode;

  constructor(code: ServerBuiltinEgressErrorCode, message: string) {
    super(message);
    this.name = "ServerBuiltinEgressError";
    this.code = code;
  }
}

export interface ServerBuiltinFetchRequest {
  url: string;
  method?: string;
  headers?: HeadersInit;
  /** Replayable bodies are required because 307/308 redirects preserve them. */
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface ServerBuiltinTransportRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: string | Uint8Array;
  readonly signal: AbortSignal;
  readonly redirect: "manual";
  readonly credentials: "omit";
  readonly trustedServingOrigin: boolean;
  /**
   * Empty only for the explicitly trusted serving origin. For an external
   * request the transport MUST connect to one of these screened addresses,
   * while retaining `url.hostname` for Host/SNI verification.
   */
  readonly resolvedAddresses: readonly string[];
}

export interface ServerBuiltinHttpTransport {
  request(
    request: ServerBuiltinTransportRequest,
  ): Response | Promise<Response>;
}

export type ResolveHostAddresses = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

export type ScheduleTimeout = (
  callback: () => void,
  milliseconds: number,
) => () => void;

export interface ServerBuiltinEgressLimits {
  timeoutMs: number;
  maxRedirects: number;
  maxRequestBodyBytes: number;
  maxResponseHeaderBytes: number;
  maxResponseBytes: number;
}

export interface ServerBuiltinFetchResult {
  response: Response;
  finalUrl: URL;
  redirectCount: number;
}

export interface ServerBuiltinFetchBroker {
  fetch(request: ServerBuiltinFetchRequest): Promise<ServerBuiltinFetchResult>;
}

/**
 * Generate-family broker boundary. Provider implementations own deployment
 * policy and credentials; neither is accepted in the pattern payload.
 */
export interface ServerBuiltinGenerateBroker<Request, Result> {
  generate(
    request: Request,
    context: { readonly onBehalfOf: string },
  ): Promise<Result>;
}

export interface ServerBuiltinBroker<GenerateRequest, GenerateResult>
  extends ServerBuiltinFetchBroker {
  readonly generate: ServerBuiltinGenerateBroker<
    GenerateRequest,
    GenerateResult
  >["generate"];
}

export interface CreateServerBuiltinEgressBrokerOptions {
  servingOrigin: string | URL;
  resolveHostAddresses: ResolveHostAddresses;
  transport: ServerBuiltinHttpTransport;
  limits?: Partial<ServerBuiltinEgressLimits>;
  scheduleTimeout?: ScheduleTimeout;
}

const DEFAULT_LIMITS: ServerBuiltinEgressLimits = {
  timeoutMs: 30_000,
  maxRedirects: 5,
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseHeaderBytes: 64 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;
const ABSOLUTE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const AUTHORITY_PREFIX = /^[\\/]{2}/;
const textEncoder = new TextEncoder();

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "permissions-policy",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);

const METADATA_HOSTS = new Set([
  "instance-data",
  "instance-data.ec2.internal",
  "metadata",
  "metadata.google.internal",
]);

const defaultScheduleTimeout: ScheduleTimeout = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};

const fail = (
  code: ServerBuiltinEgressErrorCode,
  message: string,
): never => {
  throw new ServerBuiltinEgressError(code, message);
};

const checkedPositiveInteger = (
  value: number,
  name: keyof ServerBuiltinEgressLimits,
  allowZero = false,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new TypeError(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }
  return value;
};

const normalizeLimits = (
  limits: Partial<ServerBuiltinEgressLimits> | undefined,
): ServerBuiltinEgressLimits => ({
  timeoutMs: checkedPositiveInteger(
    limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    "timeoutMs",
  ),
  maxRedirects: checkedPositiveInteger(
    limits?.maxRedirects ?? DEFAULT_LIMITS.maxRedirects,
    "maxRedirects",
    true,
  ),
  maxRequestBodyBytes: checkedPositiveInteger(
    limits?.maxRequestBodyBytes ?? DEFAULT_LIMITS.maxRequestBodyBytes,
    "maxRequestBodyBytes",
  ),
  maxResponseHeaderBytes: checkedPositiveInteger(
    limits?.maxResponseHeaderBytes ?? DEFAULT_LIMITS.maxResponseHeaderBytes,
    "maxResponseHeaderBytes",
  ),
  maxResponseBytes: checkedPositiveInteger(
    limits?.maxResponseBytes ?? DEFAULT_LIMITS.maxResponseBytes,
    "maxResponseBytes",
  ),
});

const canonicalServingOrigin = (input: string | URL): URL => {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return fail("invalid-serving-origin", "serving origin is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail(
      "invalid-serving-origin",
      "serving origin must use http or https",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return fail(
      "invalid-serving-origin",
      "serving origin must not contain credentials",
    );
  }
  return new URL(parsed.origin);
};

const normalizeMethod = (method: string | undefined): string => {
  const normalized = (method ?? "GET").trim().toUpperCase();
  if (
    normalized === "" || !METHOD_TOKEN.test(normalized) ||
    FORBIDDEN_METHODS.has(normalized)
  ) {
    return fail(
      "invalid-method",
      `method ${JSON.stringify(method)} is not allowed`,
    );
  }
  return normalized;
};

const normalizeHeaders = (input: HeadersInit | undefined): Headers => {
  let headers: Headers;
  try {
    headers = new Headers(input);
  } catch {
    return fail("invalid-headers", "request headers are malformed");
  }
  for (const name of [...headers.keys()]) {
    if (
      FORBIDDEN_REQUEST_HEADERS.has(name) || name.startsWith("proxy-") ||
      name.startsWith("sec-")
    ) {
      headers.delete(name);
    }
  }
  if (!headers.has("accept")) headers.set("accept", "*/*");
  headers.set("user-agent", "Common-Fabric-Server-Builtin/1");
  return headers;
};

const bodyByteLength = (body: string | Uint8Array | undefined): number =>
  typeof body === "string"
    ? textEncoder.encode(body).byteLength
    : body?.byteLength ?? 0;

const copyBody = (
  body: string | Uint8Array | undefined,
): string | Uint8Array | undefined =>
  body instanceof Uint8Array ? body.slice() : body;

interface ParsedTarget {
  url: URL;
  trustedServingOrigin: boolean;
}

const parseInitialTarget = (
  input: string,
  servingOrigin: URL,
): ParsedTarget => {
  const trimmed = input.trim();
  const explicitlyExternal = ABSOLUTE_SCHEME.test(trimmed) ||
    AUTHORITY_PREFIX.test(trimmed);
  const url = parseTargetUrl(trimmed, servingOrigin);
  return {
    url,
    trustedServingOrigin: !explicitlyExternal &&
      url.origin === servingOrigin.origin,
  };
};

const parseTargetUrl = (input: string, base: URL): URL => {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return fail("invalid-url", "builtin request URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(
      "blocked-scheme",
      `builtin request scheme ${url.protocol} is not allowed`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    return fail(
      "invalid-url",
      "builtin request URL must not contain credentials",
    );
  }
  url.hash = "";
  return url;
};

const normalizeHostname = (hostname: string): string =>
  hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

const blockedHostnameReason = (hostname: string): string | undefined => {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === "" || normalized === "localhost" ||
    normalized.endsWith(".localhost") || normalized.endsWith(".local") ||
    normalized.endsWith(".internal") || METADATA_HOSTS.has(normalized)
  ) {
    return `host ${hostname} is local, private, or a metadata service`;
  }
  return undefined;
};

const parseIpv4 = (input: string): Uint8Array | undefined => {
  const parts = input.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes[index] = value;
  }
  return bytes;
};

const expandEmbeddedIpv4 = (input: string): string | undefined => {
  if (!input.includes(".")) return input;
  const separator = input.lastIndexOf(":");
  if (separator < 0) return undefined;
  const ipv4 = parseIpv4(input.slice(separator + 1));
  if (ipv4 === undefined) return undefined;
  const high = (ipv4[0] << 8) | ipv4[1];
  const low = (ipv4[2] << 8) | ipv4[3];
  return `${input.slice(0, separator)}:${high.toString(16)}:${
    low.toString(16)
  }`;
};

const parseIpv6 = (input: string): Uint8Array | undefined => {
  let normalized = normalizeHostname(input);
  if (normalized.includes("%")) return undefined;
  const expandedIpv4 = expandEmbeddedIpv4(normalized);
  if (expandedIpv4 === undefined) return undefined;
  normalized = expandedIpv4;

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): string[] | undefined => {
    if (half === "") return [];
    const groups = half.split(":");
    return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
      ? groups
      : undefined;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const omitted = 8 - left.length - right.length;
  if (
    (halves.length === 1 && omitted !== 0) ||
    (halves.length === 2 && omitted < 1)
  ) {
    return undefined;
  }
  const groups = [
    ...left,
    ...Array.from({ length: omitted }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
};

const hasPrefix = (
  bytes: Uint8Array,
  prefix: readonly number[],
  bits: number,
): boolean => {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== (prefix[index] ?? 0)) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes] & mask) === ((prefix[fullBytes] ?? 0) & mask);
};

const isAllowedIpv4 = (bytes: Uint8Array): boolean => {
  const [a, b] = bytes;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 88 && bytes[2] === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && bytes[2] === 100) return false;
  if (a === 203 && b === 0 && bytes[2] === 113) return false;
  return a < 224;
};

const isAllowedIpv6 = (bytes: Uint8Array): boolean => {
  // IPv4-mapped addresses inherit the embedded IPv4 policy.
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff
  ) {
    return isAllowedIpv4(bytes.slice(12));
  }
  // Conservatively admit global unicast only (2000::/3), then remove special
  // purpose ranges inside it.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return false; // Teredo
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x02], 48)) return false; // benchmark
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x10], 28)) return false; // ORCHID
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28)) return false; // ORCHIDv2
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false; // docs
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return false; // 6to4 tunnel
  if (hasPrefix(bytes, [0x3f, 0xff], 20)) return false; // documentation
  return true;
};

/** True only for a syntactically valid, globally routable IP address. */
export const isAllowedExternalAddress = (address: string): boolean => {
  const normalized = normalizeHostname(address);
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) return isAllowedIpv4(ipv4);
  const ipv6 = parseIpv6(normalized);
  return ipv6 !== undefined && isAllowedIpv6(ipv6);
};

const isIpLiteral = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  return parseIpv4(normalized) !== undefined ||
    parseIpv6(normalized) !== undefined;
};

const abortError = (signal: AbortSignal): ServerBuiltinEgressError => {
  if (signal.reason instanceof ServerBuiltinEgressError) return signal.reason;
  return new ServerBuiltinEgressError("aborted", "builtin request was aborted");
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError(signal);
};

const raceWithAbort = <T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? abortError(signal) : error);
      },
    );
  });
};

const validateExternalTarget = async (
  url: URL,
  resolver: ResolveHostAddresses,
  signal: AbortSignal,
): Promise<readonly string[]> => {
  const hostname = normalizeHostname(url.hostname);
  const hostReason = blockedHostnameReason(hostname);
  if (hostReason !== undefined) {
    return fail("blocked-destination", hostReason);
  }
  if (isIpLiteral(hostname)) {
    if (!isAllowedExternalAddress(hostname)) {
      return fail(
        "blocked-destination",
        `host ${hostname} is not a public address`,
      );
    }
    return [hostname];
  }

  let resolved: readonly string[];
  try {
    resolved = await raceWithAbort(resolver(hostname, signal), signal);
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    return fail(
      "dns-resolution-failed",
      `host ${hostname} could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (resolved.length === 0) {
    return fail(
      "dns-resolution-failed",
      `host ${hostname} did not resolve to an address`,
    );
  }
  const addresses = [...new Set(resolved.map(normalizeHostname))];
  for (const address of addresses) {
    if (!isAllowedExternalAddress(address)) {
      return fail(
        "blocked-destination",
        `host ${hostname} resolved to non-public address ${address}`,
      );
    }
  }
  return addresses;
};

const responseHeaderBytes = (headers: Headers): number => {
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += textEncoder.encode(`${name}: ${value}\r\n`).byteLength;
  }
  return bytes;
};

const cancelBody = async (
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<void> => {
  if (body === null) return;
  try {
    await raceWithAbort(body.cancel(), signal);
  } catch {
    // The policy result must not depend on a transport's cancellation error.
  }
};

const readBoundedBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^(0|[1-9][0-9]*)$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      await cancelBody(response.body, signal);
      return fail(
        "response-too-large",
        `builtin response exceeds ${maxBytes} bytes`,
      );
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the policy error if cancellation itself fails.
        }
        return fail(
          "response-too-large",
          `builtin response exceeds ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original read/abort error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const responseWithBoundedBody = async (
  response: Response,
  limits: ServerBuiltinEgressLimits,
  signal: AbortSignal,
): Promise<Response> => {
  if (responseHeaderBytes(response.headers) > limits.maxResponseHeaderBytes) {
    await cancelBody(response.body, signal);
    return fail(
      "response-headers-too-large",
      `builtin response headers exceed ${limits.maxResponseHeaderBytes} bytes`,
    );
  }
  const body = await readBoundedBody(response, limits.maxResponseBytes, signal);
  const nullBody = response.status === 204 || response.status === 205 ||
    response.status === 304;
  const responseBody = nullBody
    ? null
    : body.buffer instanceof ArrayBuffer
    ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    : body.slice().buffer as ArrayBuffer;
  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const redirectRequest = (
  status: number,
  method: string,
  body: string | Uint8Array | undefined,
  headers: Headers,
): { method: string; body: string | Uint8Array | undefined } => {
  if (
    (status === 303 && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST")
  ) {
    headers.delete("content-type");
    return { method: "GET", body: undefined };
  }
  return { method, body };
};

export const createServerBuiltinEgressBroker = (
  options: CreateServerBuiltinEgressBrokerOptions,
): ServerBuiltinFetchBroker => {
  const servingOrigin = canonicalServingOrigin(options.servingOrigin);
  const limits = normalizeLimits(options.limits);
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;

  return {
    async fetch(request): Promise<ServerBuiltinFetchResult> {
      let method = normalizeMethod(request.method);
      const headers = normalizeHeaders(request.headers);
      let body = copyBody(request.body);
      if ((method === "GET" || method === "HEAD") && body !== undefined) {
        return fail("invalid-method", `${method} requests cannot have a body`);
      }
      if (bodyByteLength(body) > limits.maxRequestBodyBytes) {
        return fail(
          "request-body-too-large",
          `builtin request body exceeds ${limits.maxRequestBodyBytes} bytes`,
        );
      }

      let target = parseInitialTarget(request.url, servingOrigin);
      const controller = new AbortController();
      const onCallerAbort = () => {
        controller.abort(
          new ServerBuiltinEgressError(
            "aborted",
            "builtin request was aborted",
          ),
        );
      };
      if (request.signal?.aborted) onCallerAbort();
      else {request.signal?.addEventListener("abort", onCallerAbort, {
          once: true,
        });}
      const cancelTimeout = scheduleTimeout(() => {
        controller.abort(
          new ServerBuiltinEgressError(
            "request-timeout",
            `builtin request exceeded ${limits.timeoutMs}ms`,
          ),
        );
      }, limits.timeoutMs);

      let redirectCount = 0;
      try {
        while (true) {
          throwIfAborted(controller.signal);
          const resolvedAddresses = target.trustedServingOrigin
            ? []
            : await validateExternalTarget(
              target.url,
              options.resolveHostAddresses,
              controller.signal,
            );
          throwIfAborted(controller.signal);
          const response = await raceWithAbort(
            Promise.resolve(options.transport.request({
              url: new URL(target.url),
              method,
              headers: new Headers(headers),
              body: copyBody(body),
              signal: controller.signal,
              redirect: "manual",
              credentials: "omit",
              trustedServingOrigin: target.trustedServingOrigin,
              resolvedAddresses: [...resolvedAddresses],
            })),
            controller.signal,
          );

          if (
            responseHeaderBytes(response.headers) >
              limits.maxResponseHeaderBytes
          ) {
            await cancelBody(response.body, controller.signal);
            return fail(
              "response-headers-too-large",
              `builtin response headers exceed ${limits.maxResponseHeaderBytes} bytes`,
            );
          }
          const location = response.headers.get("location");
          if (!REDIRECT_STATUSES.has(response.status) || location === null) {
            return {
              response: await responseWithBoundedBody(
                response,
                limits,
                controller.signal,
              ),
              finalUrl: new URL(target.url),
              redirectCount,
            };
          }
          if (redirectCount >= limits.maxRedirects) {
            await cancelBody(response.body, controller.signal);
            return fail(
              "too-many-redirects",
              `builtin request exceeded ${limits.maxRedirects} redirects`,
            );
          }

          const nextUrl = parseTargetUrl(location, target.url);
          const sameOrigin = nextUrl.origin === target.url.origin;
          const remainsTrusted = target.trustedServingOrigin &&
            nextUrl.origin === servingOrigin.origin;
          if (!sameOrigin) headers.delete("authorization");
          ({ method, body } = redirectRequest(
            response.status,
            method,
            body,
            headers,
          ));
          await cancelBody(response.body, controller.signal);
          target = { url: nextUrl, trustedServingOrigin: remainsTrusted };
          redirectCount += 1;
        }
      } finally {
        cancelTimeout();
        request.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
};
