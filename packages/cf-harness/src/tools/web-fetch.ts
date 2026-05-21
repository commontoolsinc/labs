import type { JSONSchema } from "@commonfabric/api";
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
) => Promise<readonly string[]>;

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
  fetchFn?: typeof fetch;
  resolveHostAddresses?: ResolveHostAddresses;
}

export const createWebFetchTool = (
  options: CreateWebFetchToolOptions = {},
): HarnessToolDefinition<WebFetchToolInput, WebFetchToolOutput> => {
  const fetchFn = options.fetchFn ?? fetch;
  const resolveHostAddresses = options.resolveHostAddresses ??
    defaultResolveHostAddresses;
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
      const initialUrl = await validatePublicHttpUrl(
        input.url,
        resolveHostAddresses,
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

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(createWebFetchAbortError());
      }, timeoutMs);
      try {
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
          url: initialUrl.url,
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

const validatePublicHttpUrl = async (
  input: string,
  resolveHostAddresses: ResolveHostAddresses,
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
  const resolution = await resolvePublicHostAddresses(
    url.hostname,
    resolveHostAddresses,
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
  if (normalized.includes(":")) {
    const mappedIpv4 = normalized.startsWith("::ffff:")
      ? normalized.slice("::ffff:".length)
      : undefined;
    if (
      isBlockedIpv6Address(normalized) ||
      (mappedIpv4 !== undefined && isBlockedIpv4Address(mappedIpv4))
    ) {
      return `web_fetch host ${hostname} is private and is not allowed`;
    }
  }
  if (isBlockedIpv4Address(normalized)) {
    return `web_fetch host ${hostname} is private and is not allowed`;
  }
  return undefined;
};

const normalizeHostname = (hostname: string): string =>
  hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

const resolvePublicHostAddresses = async (
  hostname: string,
  resolveHostAddresses: ResolveHostAddresses,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  let addresses: readonly string[];
  try {
    addresses = await resolveHostAddresses(hostname);
  } catch (error) {
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
  return { ok: true };
};

const defaultResolveHostAddresses: ResolveHostAddresses = async (
  hostname,
) => {
  const normalized = normalizeHostname(hostname);
  if (isIpv4Address(normalized) || normalized.includes(":")) {
    return [normalized];
  }
  const results = await Promise.allSettled([
    Deno.resolveDns(normalized, "A"),
    Deno.resolveDns(normalized, "AAAA"),
  ]);
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

const isIpv4Address = (value: string): boolean => {
  const octets = value.split(".").map((part) => Number(part));
  return octets.length === 4 &&
    octets.every((octet) =>
      Number.isInteger(octet) && octet >= 0 && octet <= 255
    );
};

const isBlockedIpv4Address = (value: string): boolean => {
  if (!isIpv4Address(value)) {
    return false;
  }
  const [a, b] = value.split(".").map((part) => Number(part)) as [
    number,
    number,
    number,
    number,
  ];
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
};

const isBlockedIpv6Address = (value: string): boolean => {
  if (value === "::" || value === "::1") {
    return true;
  }
  const firstHextetText = value.split(":").find((part) => part !== "");
  if (firstHextetText === undefined) {
    return false;
  }
  const firstHextet = Number.parseInt(firstHextetText, 16);
  if (!Number.isInteger(firstHextet)) {
    return false;
  }
  return (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00;
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
    const response = await options.fetchFn(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal: options.signal,
      headers: {
        Accept:
          "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
        "User-Agent": USER_AGENT,
      },
    });
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
      return {
        ok: false,
        code: "too_many_redirects",
        message: `web_fetch exceeded ${MAX_REDIRECTS} redirects`,
        finalUrl: currentUrl,
      };
    }
    const nextUrl = new URL(location, currentUrl).toString();
    const validation = await validatePublicHttpUrl(
      nextUrl,
      options.resolveHostAddresses,
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

const webFetchAbortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? createWebFetchAbortError();

const throwIfWebFetchAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw webFetchAbortReason(signal);
  }
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
