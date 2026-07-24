import type { JSONSchema } from "@commonfabric/api";
import { fetchPinnedHttp } from "@commonfabric/utils/pinned-http-fetch";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface WebFetchToolInput {
  url: string;
  maxBytes?: number;
  maxTextChars?: number;
  timeoutMs?: number;
}

export interface WebFetchLink {
  text: string;
  href: string;
}

export interface WebFetchRedirect {
  status: number;
  url: string;
  location: string;
}

export interface WebFetchToolSuccessOutput {
  type: "cf-harness.web-fetch-result";
  outputId: string;
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType?: string;
  bytes: number;
  rawContentDigest: string;
  rawContentTruncated: boolean;
  rawContent: string;
  text: string;
  textTruncated: boolean;
  title?: string;
  links?: readonly WebFetchLink[];
  redirects?: readonly WebFetchRedirect[];
  fetchedAt: string;
}

export type WebFetchErrorCode =
  | "invalid_url"
  | "blocked_url"
  | "too_many_redirects"
  | "unsupported_content_type"
  | "fetch_failed"
  | "timeout";

export interface WebFetchToolErrorOutput {
  type: "cf-harness.web-fetch-error";
  outputId: string;
  url: string;
  code: WebFetchErrorCode;
  message: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  fetchedAt: string;
}

export type WebFetchToolOutput =
  | WebFetchToolSuccessOutput
  | WebFetchToolErrorOutput;

export type WebFetchModelFacingOutput =
  | Omit<WebFetchToolSuccessOutput, "rawContent">
  | WebFetchToolErrorOutput;

export type ResolveHostAddresses = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly string[]>;

type WebFetchHttpFetch = typeof fetch;

const DEFAULT_MAX_BYTES = 200_000;
const MAX_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const MAX_MAX_TEXT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const MAX_LINKS = 50;
const USER_AGENT = "cf-harness-web-fetch/1.0";

export const webFetchToolDescriptor: HarnessToolDescriptor = {
  toolId: "web_fetch",
  title: "Web Fetch",
  description:
    "Fetch a public HTTP(S) URL with bounded output, redirect validation, and extracted text metadata. Does not use cookies or ambient browser state.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      maxBytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MAX_BYTES,
      },
      maxTextChars: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MAX_TEXT_CHARS,
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ["url"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        type: { type: "string", const: "cf-harness.web-fetch-result" },
        outputId: { type: "string" },
        url: { type: "string" },
        finalUrl: { type: "string" },
        status: { type: "number" },
        ok: { type: "boolean" },
        contentType: { type: "string" },
        bytes: { type: "number" },
        rawContentDigest: { type: "string" },
        rawContentTruncated: { type: "boolean" },
        rawContent: { type: "string" },
        text: { type: "string" },
        textTruncated: { type: "boolean" },
        title: { type: "string" },
        links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              href: { type: "string" },
            },
            required: ["text", "href"],
            additionalProperties: false,
          },
        },
        redirects: {
          type: "array",
          items: {
            type: "object",
            properties: {
              status: { type: "number" },
              url: { type: "string" },
              location: { type: "string" },
            },
            required: ["status", "url", "location"],
            additionalProperties: false,
          },
        },
        fetchedAt: { type: "string" },
      },
      required: [
        "type",
        "outputId",
        "url",
        "finalUrl",
        "status",
        "ok",
        "bytes",
        "rawContentDigest",
        "rawContentTruncated",
        "rawContent",
        "text",
        "textTruncated",
        "fetchedAt",
      ],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        type: { type: "string", const: "cf-harness.web-fetch-error" },
        outputId: { type: "string" },
        url: { type: "string" },
        code: {
          type: "string",
          enum: [
            "invalid_url",
            "blocked_url",
            "too_many_redirects",
            "unsupported_content_type",
            "fetch_failed",
            "timeout",
          ],
        },
        message: { type: "string" },
        finalUrl: { type: "string" },
        status: { type: "number" },
        contentType: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["type", "outputId", "url", "code", "message", "fetchedAt"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["web", "fetch", "read"],
};

export interface CreateWebFetchToolOptions {
  fetchFn?: WebFetchHttpFetch;
  resolveHostAddresses?: ResolveHostAddresses;
}

export const createWebFetchTool = (
  options: CreateWebFetchToolOptions = {},
): HarnessToolDefinition<WebFetchToolInput, WebFetchToolOutput> => {
  const resolveHostAddresses = options.resolveHostAddresses ??
    defaultResolveHostAddresses;
  const fetchFn = options.fetchFn ??
    createPinnedPublicFetch(resolveHostAddresses);
  return {
    descriptor: webFetchToolDescriptor,
    async invoke(context, input) {
      const outputId = context.nextOutputId("web_fetch");
      const fetchedAt = context.now();
      const maxBytes = boundedIntegerOrDefault(
        input.maxBytes,
        DEFAULT_MAX_BYTES,
        MAX_MAX_BYTES,
        "web_fetch maxBytes",
      );
      const maxTextChars = boundedIntegerOrDefault(
        input.maxTextChars,
        DEFAULT_MAX_TEXT_CHARS,
        MAX_MAX_TEXT_CHARS,
        "web_fetch maxTextChars",
      );
      const timeoutMs = boundedIntegerOrDefault(
        input.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
        "web_fetch timeoutMs",
      );
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(createWebFetchAbortError());
      }, timeoutMs);
      let resultUrl = input.url;
      try {
        const initialUrl = await validatePublicHttpUrl(
          input.url,
          resolveHostAddresses,
          controller.signal,
        );
        if (!initialUrl.ok) {
          return webFetchError({
            outputId,
            url: input.url,
            code: initialUrl.code,
            message: initialUrl.message,
            fetchedAt,
          });
        }
        resultUrl = initialUrl.url;
        const fetchResult = await fetchWithRedirects({
          url: initialUrl.url,
          fetchFn,
          resolveHostAddresses,
          signal: controller.signal,
        });

        if (!fetchResult.ok) {
          return webFetchError({
            outputId,
            url: initialUrl.url,
            code: fetchResult.code,
            message: fetchResult.message,
            finalUrl: fetchResult.finalUrl,
            fetchedAt,
          });
        }

        const response = fetchResult.response;
        const contentType = response.headers.get("content-type") ?? undefined;
        if (!isSupportedContentType(contentType)) {
          await cancelResponseBody(response);
          return webFetchError({
            outputId,
            url: initialUrl.url,
            code: "unsupported_content_type",
            message: contentType === undefined
              ? "web_fetch response did not include a supported text content-type"
              : `web_fetch content-type ${contentType} is not supported`,
            finalUrl: fetchResult.finalUrl,
            status: response.status,
            contentType,
            fetchedAt,
          });
        }

        const body = await readResponseBody(
          response,
          maxBytes,
          controller.signal,
        );
        const rawContent = new TextDecoder().decode(body.bytes);
        const extraction = extractText(
          rawContent,
          fetchResult.finalUrl,
          contentType,
        );
        const text = truncateString(extraction.text, maxTextChars);
        return {
          type: "cf-harness.web-fetch-result",
          outputId,
          url: initialUrl.url,
          finalUrl: fetchResult.finalUrl,
          status: response.status,
          ok: response.ok,
          ...(contentType !== undefined ? { contentType } : {}),
          bytes: body.bytes.byteLength,
          rawContentDigest: await digestBytes(body.bytes),
          rawContentTruncated: body.truncated,
          rawContent,
          text: text.value,
          textTruncated: text.truncated,
          ...(extraction.title !== undefined
            ? { title: extraction.title }
            : {}),
          ...(extraction.links.length > 0
            ? { links: extraction.links.slice(0, MAX_LINKS) }
            : {}),
          ...(fetchResult.redirects.length > 0
            ? { redirects: fetchResult.redirects }
            : {}),
          fetchedAt,
        };
      } catch (error) {
        return webFetchError({
          outputId,
          url: resultUrl,
          code: isAbortError(error) ? "timeout" : "fetch_failed",
          message: error instanceof Error ? error.message : String(error),
          fetchedAt,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

export const isWebFetchToolSuccessOutput = (
  output: unknown,
): output is WebFetchToolSuccessOutput =>
  typeof output === "object" &&
  output !== null &&
  "type" in output &&
  output.type === "cf-harness.web-fetch-result" &&
  "outputId" in output &&
  typeof output.outputId === "string";

export const isWebFetchToolErrorOutput = (
  output: unknown,
): output is WebFetchToolErrorOutput =>
  typeof output === "object" &&
  output !== null &&
  "type" in output &&
  output.type === "cf-harness.web-fetch-error" &&
  "outputId" in output &&
  typeof output.outputId === "string";

export const toModelFacingWebFetchOutput = (
  output: WebFetchToolOutput,
): WebFetchModelFacingOutput => {
  if (!isWebFetchToolSuccessOutput(output)) {
    return output;
  }
  const { rawContent: _rawContent, ...modelFacing } = output;
  return modelFacing;
};

interface WebFetchErrorOptions {
  outputId: string;
  url: string;
  code: WebFetchErrorCode;
  message: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  fetchedAt: string;
}

const webFetchError = (
  options: WebFetchErrorOptions,
): WebFetchToolErrorOutput => ({
  type: "cf-harness.web-fetch-error",
  outputId: options.outputId,
  url: options.url,
  code: options.code,
  message: options.message,
  ...(options.finalUrl !== undefined ? { finalUrl: options.finalUrl } : {}),
  ...(options.status !== undefined ? { status: options.status } : {}),
  ...(options.contentType !== undefined
    ? { contentType: options.contentType }
    : {}),
  fetchedAt: options.fetchedAt,
});

const boundedIntegerOrDefault = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
};

type PublicHttpUrlResult =
  | { ok: true; url: string }
  | { ok: false; code: "invalid_url" | "blocked_url"; message: string };

class WebFetchBlockedUrlError extends Error {
  readonly code = "blocked_url" as const;
}

const validatePublicHttpUrl = async (
  input: string,
  resolveHostAddresses: ResolveHostAddresses,
  signal?: AbortSignal,
): Promise<PublicHttpUrlResult> => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      ok: false,
      code: "invalid_url",
      message: `web_fetch url is not valid: ${input}`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      code: "invalid_url",
      message: `web_fetch protocol ${url.protocol} is not supported`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      code: "blocked_url",
      message: "web_fetch URLs may not include credentials",
    };
  }
  const hostBlockReason = blockedHostReason(url.hostname);
  if (hostBlockReason !== undefined) {
    return {
      ok: false,
      code: "blocked_url",
      message: hostBlockReason,
    };
  }
  const resolution = await resolveValidatedPublicAddresses(
    url.hostname,
    resolveHostAddresses,
    signal,
  );
  if (!resolution.ok) {
    return {
      ok: false,
      code: "blocked_url",
      message: resolution.message,
    };
  }
  return { ok: true, url: url.toString() };
};

const blockedHostReason = (hostname: string): string | undefined => {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized === "host.docker.internal" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return `web_fetch host ${hostname} is local and is not allowed`;
  }
  if (isIpv6Address(normalized) && isBlockedIpv6Address(normalized)) {
    return `web_fetch host ${hostname} is private and is not allowed`;
  }
  if (isBlockedIpv4Address(normalized)) {
    return `web_fetch host ${hostname} is private and is not allowed`;
  }
  return undefined;
};

const normalizeHostname = (hostname: string): string =>
  hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

const resolveValidatedPublicAddresses = async (
  hostname: string,
  resolveHostAddresses: ResolveHostAddresses,
  signal?: AbortSignal,
): Promise<
  | { ok: true; addresses: readonly string[] }
  | { ok: false; message: string }
> => {
  let addresses: readonly string[];
  try {
    throwIfWebFetchAborted(signal);
    addresses = await withWebFetchAbort(
      resolveHostAddresses(hostname, signal),
      signal,
    );
    throwIfWebFetchAborted(signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      ok: false,
      message:
        `web_fetch host ${hostname} could not be resolved to a public address: ${
          error instanceof Error ? error.message : String(error)
        }`,
    };
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      message:
        `web_fetch host ${hostname} could not be resolved to a public address`,
    };
  }
  for (const address of addresses) {
    const addressBlockReason = blockedResolvedAddressReason(hostname, address);
    if (addressBlockReason !== undefined) {
      return { ok: false, message: addressBlockReason };
    }
  }
  return { ok: true, addresses };
};

const defaultResolveHostAddresses: ResolveHostAddresses = async (
  hostname,
  signal,
) => {
  const normalized = normalizeHostname(hostname);
  if (isIpv4Address(normalized) || normalized.includes(":")) {
    return [normalized];
  }
  const results = await withWebFetchAbort(
    Promise.allSettled([
      Deno.resolveDns(normalized, "A"),
      Deno.resolveDns(normalized, "AAAA"),
    ]),
    signal,
  );
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  if (addresses.length === 0) {
    const firstError = results.find((
      result,
    ): result is PromiseRejectedResult => result.status === "rejected");
    if (firstError !== undefined) {
      throw firstError.reason;
    }
  }
  return addresses;
};

const blockedResolvedAddressReason = (
  hostname: string,
  address: string,
): string | undefined => {
  const addressHostReason = blockedHostReason(address);
  if (addressHostReason !== undefined) {
    return `web_fetch host ${hostname} resolved to private address ${address} and is not allowed`;
  }
  return undefined;
};

const createPinnedPublicFetch = (
  resolveHostAddresses: ResolveHostAddresses,
): WebFetchHttpFetch =>
async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const signal = init.signal ?? undefined;
  throwIfWebFetchAborted(signal);
  const resolution = await resolveValidatedPublicAddresses(
    url.hostname,
    resolveHostAddresses,
    signal,
  );
  if (!resolution.ok) {
    throw new WebFetchBlockedUrlError(resolution.message);
  }
  throwIfWebFetchAborted(signal);
  const errors: string[] = [];
  for (const address of resolution.addresses) {
    try {
      const method = (init.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        throw new Error("web_fetch only supports GET requests");
      }
      return await fetchPinnedHttp(url, address, {
        method,
        headers: init.headers,
        signal,
        errorLabel: "web_fetch",
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `web_fetch could not connect to public host ${url.hostname}: ${
      errors.join("; ")
    }`,
  );
};

const isIpv4Address = (value: string): boolean => {
  const octets = value.split(".").map((part) => Number(part));
  return octets.length === 4 &&
    octets.every((octet) =>
      Number.isInteger(octet) && octet >= 0 && octet <= 255
    );
};

const isBlockedIpv4Address = (value: string): boolean => {
  const octets = parseIpv4Address(value);
  if (octets === undefined) {
    return false;
  }
  return !isGloballyRoutableIpv4(octets);
};

const parseIpv4Address = (
  value: string,
): [number, number, number, number] | undefined => {
  const octets = value.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    !octets.every((octet) =>
      Number.isInteger(octet) && octet >= 0 && octet <= 255
    )
  ) {
    return undefined;
  }
  return octets as [number, number, number, number];
};

const isGloballyRoutableIpv4 = (
  [a, b, c, d]: [number, number, number, number],
): boolean => {
  if (a === 0) return false; // Current network.
  if (a === 10) return false; // RFC 1918 private.
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT.
  if (a === 127) return false; // Loopback.
  if (a === 169 && b === 254) return false; // Link-local.
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918 private.
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments.
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1.
  if (a === 192 && b === 88 && c === 99) return false; // Deprecated 6to4 relay anycast.
  if (a === 192 && b === 168) return false; // RFC 1918 private.
  if (a === 198 && (b === 18 || b === 19)) return false; // Benchmarking.
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2.
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3.
  if (a >= 224) return false; // Multicast, reserved, broadcast.
  return !(a === 255 && b === 255 && c === 255 && d === 255);
};

const isBlockedIpv6Address = (value: string): boolean => {
  const bytes = parseIpv6Address(value);
  if (bytes === undefined) {
    return false;
  }
  return !isGloballyRoutableIpv6(bytes);
};

const isIpv6Address = (value: string): boolean =>
  parseIpv6Address(value) !== undefined;

const parseIpv6Address = (value: string): Uint8Array | undefined => {
  const normalized = value.toLowerCase();
  if (normalized === "") {
    return undefined;
  }
  const doubleColon = normalized.match(/::/g) ?? [];
  if (doubleColon.length > 1) {
    return undefined;
  }

  let input = normalized;
  const embeddedIpv4Match = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(input);
  if (embeddedIpv4Match !== null) {
    const ipv4 = parseIpv4Address(embeddedIpv4Match[2]!);
    if (ipv4 === undefined) {
      return undefined;
    }
    const ipv4Hextets = [
      ((ipv4[0] << 8) | ipv4[1]).toString(16),
      ((ipv4[2] << 8) | ipv4[3]).toString(16),
    ];
    input = `${input.slice(0, embeddedIpv4Match.index + 1)}${
      ipv4Hextets.join(":")
    }`;
  }

  const hasCompression = input.includes("::");
  const [headText, tailText = ""] = input.split("::", 2);
  const head = headText === "" ? [] : headText.split(":");
  const tail = tailText === "" ? [] : tailText.split(":");
  if (
    head.some((part) => part === "") ||
    tail.some((part) => part === "")
  ) {
    return undefined;
  }
  const explicitParts = [...head, ...tail];
  if (hasCompression) {
    if (explicitParts.length >= 8) {
      return undefined;
    }
  } else if (explicitParts.length !== 8) {
    return undefined;
  }
  const missingParts = hasCompression ? 8 - explicitParts.length : 0;
  const parts = [...head, ...Array(missingParts).fill("0"), ...tail];
  const bytes = new Uint8Array(16);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return undefined;
    }
    const value = Number.parseInt(part, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
};

const isGloballyRoutableIpv6 = (bytes: Uint8Array): boolean => {
  const mappedIpv4 = ipv4FromMappedIpv6(bytes) ??
    ipv4FromNat64WellKnownPrefix(bytes);
  if (mappedIpv4 !== undefined) {
    return isGloballyRoutableIpv4(mappedIpv4);
  }
  if (bytes.every((byte) => byte === 0)) return false; // Unspecified.
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return false; // Loopback.
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return false; // Unique local.
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) {
    return false; // Link-local.
  }
  if (bytes[0] === 0xff) return false; // Multicast.
  if (!((bytes[0]! & 0xe0) === 0x20)) {
    return false; // Not global unicast 2000::/3.
  }
  if (hasIpv6Prefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) {
    return false; // Documentation.
  }
  if (hasIpv6Prefix(bytes, [0x20, 0x02], 16)) {
    return false; // Deprecated 6to4.
  }
  if (hasIpv6Prefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) {
    return false; // Teredo.
  }
  if (hasIpv6Prefix(bytes, [0x20, 0x01, 0x00, 0x02], 48)) {
    return false; // Benchmarking.
  }
  if (hasIpv6Prefix(bytes, [0x20, 0x01, 0x00, 0x10], 28)) {
    return false; // ORCHID.
  }
  return true;
};

const ipv4FromMappedIpv6 = (
  bytes: Uint8Array,
): [number, number, number, number] | undefined => {
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  }
  return undefined;
};

const ipv4FromNat64WellKnownPrefix = (
  bytes: Uint8Array,
): [number, number, number, number] | undefined => {
  if (hasIpv6Prefix(bytes, [0x00, 0x64, 0xff, 0x9b], 96)) {
    return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  }
  return undefined;
};

const hasIpv6Prefix = (
  bytes: Uint8Array,
  prefix: readonly number[],
  bitLength: number,
): boolean => {
  const fullBytes = Math.floor(bitLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== (prefix[index] ?? 0)) {
      return false;
    }
  }
  const remainingBits = bitLength % 8;
  if (remainingBits === 0) {
    return true;
  }
  const mask = 0xff << (8 - remainingBits) & 0xff;
  return (bytes[fullBytes]! & mask) === ((prefix[fullBytes] ?? 0) & mask);
};

interface FetchWithRedirectsOptions {
  url: string;
  fetchFn: typeof fetch;
  resolveHostAddresses: ResolveHostAddresses;
  signal: AbortSignal;
}

type FetchWithRedirectsResult =
  | {
    ok: true;
    response: Response;
    finalUrl: string;
    redirects: WebFetchRedirect[];
  }
  | {
    ok: false;
    code: "blocked_url" | "too_many_redirects";
    message: string;
    finalUrl?: string;
  };

const fetchWithRedirects = async (
  options: FetchWithRedirectsOptions,
): Promise<FetchWithRedirectsResult> => {
  let currentUrl = options.url;
  const redirects: WebFetchRedirect[] = [];
  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    throwIfWebFetchAborted(options.signal);
    let response: Response;
    try {
      response = await options.fetchFn(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: options.signal,
        headers: {
          Accept:
            "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
          "User-Agent": USER_AGENT,
        },
      });
    } catch (error) {
      if (error instanceof WebFetchBlockedUrlError) {
        return {
          ok: false,
          code: error.code,
          message: error.message,
          finalUrl: currentUrl,
        };
      }
      throw error;
    }
    const location = response.headers.get("location");
    if (
      response.status < 300 ||
      response.status >= 400 ||
      location === null
    ) {
      return {
        ok: true,
        response,
        finalUrl: currentUrl,
        redirects,
      };
    }
    if (redirectCount === MAX_REDIRECTS) {
      await cancelResponseBody(response);
      return {
        ok: false,
        code: "too_many_redirects",
        message: `web_fetch exceeded ${MAX_REDIRECTS} redirects`,
        finalUrl: currentUrl,
      };
    }
    const nextUrl = new URL(location, currentUrl).toString();
    await cancelResponseBody(response);
    const validation = await validatePublicHttpUrl(
      nextUrl,
      options.resolveHostAddresses,
      options.signal,
    );
    if (!validation.ok) {
      return {
        ok: false,
        code: validation.code === "invalid_url"
          ? "blocked_url"
          : validation.code,
        message: `web_fetch redirect target denied: ${validation.message}`,
        finalUrl: currentUrl,
      };
    }
    redirects.push({
      status: response.status,
      url: currentUrl,
      location: validation.url,
    });
    currentUrl = validation.url;
  }
  return {
    ok: false,
    code: "too_many_redirects",
    message: `web_fetch exceeded ${MAX_REDIRECTS} redirects`,
    finalUrl: currentUrl,
  };
};

const createWebFetchAbortError = (): DOMException =>
  new DOMException("web_fetch timed out", "AbortError");

const webFetchAbortReason = (signal?: AbortSignal): unknown =>
  signal?.reason ?? createWebFetchAbortError();

const throwIfWebFetchAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw webFetchAbortReason(signal);
  }
};

const withWebFetchAbort = async <T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (signal === undefined) {
    return await promise;
  }
  throwIfWebFetchAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(webFetchAbortReason(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        if (signal.aborted) {
          reject(webFetchAbortReason(signal));
          return;
        }
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(signal.aborted ? webFetchAbortReason(signal) : error);
      },
    );
  });
};

const readChunkWithAbort = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  throwIfWebFetchAborted(signal);
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(webFetchAbortReason(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
};

const cancelReaderAfterAbort = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<void> => {
  if (!signal.aborted) {
    return;
  }
  try {
    await reader.cancel(webFetchAbortReason(signal));
  } catch {
    // Ignore cancellation cleanup failures; the timeout itself is the result.
  }
};

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore cancellation cleanup failures; the tool is already returning.
  }
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const isSupportedContentType = (contentType: string | undefined): boolean => {
  if (contentType === undefined) {
    return false;
  }
  const normalized = contentType.split(";")[0]!.trim().toLowerCase();
  return normalized === "text/html" ||
    normalized === "application/xhtml+xml" ||
    normalized === "text/plain" ||
    normalized === "application/json" ||
    normalized.endsWith("+json");
};

export const webFetchTool = createWebFetchTool();

interface ReadBodyResult {
  bytes: Uint8Array;
  truncated: boolean;
}

const readResponseBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ReadBodyResult> => {
  if (response.body === null) {
    return { bytes: new Uint8Array(), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await readChunkWithAbort(reader, signal);
      if (done) {
        break;
      }
      if (value === undefined || value.byteLength === 0) {
        continue;
      }
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          total += remaining;
        }
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await cancelReaderAfterAbort(reader, signal);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
};

interface ExtractedText {
  text: string;
  title?: string;
  links: WebFetchLink[];
}

const extractText = (
  rawContent: string,
  finalUrl: string,
  contentType: string | undefined,
): ExtractedText => {
  const normalizedContentType = contentType?.split(";")[0]?.trim()
    .toLowerCase();
  const looksHtml = normalizedContentType === "text/html" ||
    normalizedContentType === "application/xhtml+xml" ||
    (contentType === undefined && /<\/?[a-z][\s\S]*>/i.test(rawContent));
  if (!looksHtml) {
    return { text: rawContent, links: [] };
  }
  const title = extractTitle(rawContent);
  const links = extractLinks(rawContent, finalUrl);
  return {
    text: htmlToText(rawContent),
    ...(title !== undefined ? { title } : {}),
    links,
  };
};

const extractTitle = (html: string): string | undefined => {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) {
    return undefined;
  }
  const title = normalizeWhitespace(decodeHtmlEntities(stripTags(match[1]!)));
  return title === "" ? undefined : title;
};

const extractLinks = (html: string, finalUrl: string): WebFetchLink[] => {
  const links: WebFetchLink[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null && links.length < MAX_LINKS) {
    const attrs = match[1] ?? "";
    const href = extractHref(attrs);
    if (href === undefined) {
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(decodeHtmlEntities(href), finalUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }
    const text = normalizeWhitespace(
      decodeHtmlEntities(stripTags(match[2] ?? "")),
    );
    links.push({
      text,
      href: resolved.toString(),
    });
  }
  return links;
};

const extractHref = (attrs: string): string | undefined => {
  const quoted = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(attrs);
  if (quoted !== null) {
    return quoted[2];
  }
  const unquoted = /\bhref\s*=\s*([^\s"'=<>`]+)/i.exec(attrs);
  return unquoted?.[1];
};

const htmlToText = (html: string): string => {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
  const withBreaks = withoutNoise
    .replace(
      /<\/(p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|table|blockquote)>/gi,
      "\n",
    )
    .replace(/<br\s*\/?>/gi, "\n");
  return decodeHtmlEntities(stripTags(withBreaks))
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)
    .join("\n");
};

const stripTags = (input: string): string => input.replace(/<[^>]*>/g, " ");

const normalizeWhitespace = (input: string): string =>
  input.replace(/\s+/g, " ").trim();

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const decodeHtmlEntities = (input: string): string =>
  input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, body) => {
    const normalized = String(body).toLowerCase();
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint)
        ? safeCodePoint(codePoint, entity)
        : entity;
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint)
        ? safeCodePoint(codePoint, entity)
        : entity;
    }
    return HTML_ENTITY_MAP[normalized] ?? entity;
  });

const safeCodePoint = (codePoint: number, fallback: string): string => {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
};

const truncateString = (
  value: string,
  maxChars: number,
): { value: string; truncated: boolean } =>
  value.length > maxChars
    ? { value: value.slice(0, maxChars), truncated: true }
    : { value, truncated: false };

const digestBytes = async (bytes: Uint8Array): Promise<string> => {
  const digestInput = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};
