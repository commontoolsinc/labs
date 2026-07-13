/**
 * A minimal HTTP/1.1 client that connects to an already-resolved address.
 *
 * Callers remain responsible for resolving and screening the address. The URL
 * hostname is retained for the Host header and HTTPS certificate verification,
 * closing the DNS-rebinding gap without weakening TLS identity checks.
 *
 * This is a Deno-only package subpath. It deliberately does not follow
 * redirects, decode compressed content, use cookies, or consult ambient proxy
 * configuration.
 */

export interface PinnedHttpFetchInit {
  method?: string;
  headers?: HeadersInit;
  /** Replayable request bodies only; streaming and implicit chunking are out. */
  body?: string | Uint8Array;
  signal?: AbortSignal;
  maxResponseHeaderBytes?: number;
  /** Prefix for diagnostics surfaced by a higher-level caller. */
  errorLabel?: string;
}

type Bytes = Uint8Array<ArrayBuffer>;

const DEFAULT_MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const MAX_INFORMATIONAL_RESPONSES = 16;
const MAX_CHUNKED_LINE_BYTES = 4096;
const MAX_CHUNKED_TRAILER_BYTES = 16 * 1024;
const MAX_CHUNKED_TRAILER_LINES = 100;
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;
const textEncoder = new TextEncoder();

const FORBIDDEN_SERIALIZED_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Perform one HTTP request through `address`, retaining `url.hostname` for
 * Host and TLS SNI/certificate verification.
 *
 * The returned standard Response does not carry a synthetic `url`: callers
 * already own the URL and remain responsible for redirect handling.
 */
export const fetchPinnedHttp = async (
  url: URL,
  address: string,
  init: PinnedHttpFetchInit = {},
): Promise<Response> => {
  const errorLabel = init.errorLabel ?? "pinned HTTP";
  validateUrl(url, errorLabel);
  const method = normalizeMethod(init.method, errorLabel);
  if (
    init.body !== undefined && (method === "GET" || method === "HEAD")
  ) {
    throw new TypeError(`${errorLabel} ${method} requests cannot have a body`);
  }
  const maxResponseHeaderBytes = normalizeHeaderLimit(
    init.maxResponseHeaderBytes,
  );
  const port = url.port === ""
    ? (url.protocol === "https:" ? 443 : 80)
    : Number(url.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError(`${errorLabel} URL port is not valid: ${url.port}`);
  }

  const signal = init.signal;
  const conn = await openPinnedConnection(
    url,
    normalizeAddress(address),
    port,
    signal,
  );
  const abortHandler = signal === undefined
    ? undefined
    : () => closeConnection(conn);
  if (signal !== undefined && abortHandler !== undefined) {
    signal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    const body = encodeRequestBody(init.body);
    const requestHead = serializeHttpRequest(
      url,
      method,
      init.headers,
      body?.byteLength,
    );
    await writeAll(conn, textEncoder.encode(requestHead), signal);
    if (body !== undefined && body.byteLength > 0) {
      await writeAll(conn, body, signal);
    }
    const response = await readHttpResponseHead(
      conn,
      maxResponseHeaderBytes,
      signal,
      errorLabel,
    );
    const bodyIsForbidden = method === "HEAD" ||
      response.status === 204 || response.status === 205 ||
      response.status === 304;
    const responseBody = bodyIsForbidden ? null : createHttpResponseBodyStream(
      conn,
      response.bodyPrefix,
      response.headers,
      signal,
      errorLabel,
    );
    if (bodyIsForbidden) {
      closeConnection(conn);
    }
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    closeConnection(conn);
    throw error;
  } finally {
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
};

const validateUrl = (url: URL, errorLabel: string): void => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      `${errorLabel} protocol ${url.protocol} is not supported`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`${errorLabel} URL may not include credentials`);
  }
  if (url.hostname === "") {
    throw new TypeError(`${errorLabel} URL must include a hostname`);
  }
};

const normalizeMethod = (
  method: string | undefined,
  errorLabel: string,
): string => {
  const normalized = (method ?? "GET").trim().toUpperCase();
  if (normalized === "" || !METHOD_TOKEN.test(normalized)) {
    throw new TypeError(`${errorLabel} method is not a valid HTTP token`);
  }
  return normalized;
};

const normalizeHeaderLimit = (value: number | undefined): number => {
  const normalized = value ?? DEFAULT_MAX_RESPONSE_HEADER_BYTES;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError("maxResponseHeaderBytes must be a positive integer");
  }
  return normalized;
};

const normalizeAddress = (address: string): string =>
  address.replace(/^\[|\]$/g, "");

const normalizeHostname = (hostname: string): string =>
  hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

const encodeRequestBody = (
  body: string | Uint8Array | undefined,
): Bytes | undefined => {
  if (typeof body === "string") {
    return textEncoder.encode(body);
  }
  return body === undefined ? undefined : body.slice();
};

const openPinnedConnection = async (
  url: URL,
  address: string,
  port: number,
  signal?: AbortSignal,
): Promise<Deno.Conn> => {
  throwIfAborted(signal);
  const connect = Deno.connect({ hostname: address, port, signal });
  if (signal !== undefined) {
    connect.then((conn) => {
      if (signal.aborted) {
        closeConnection(conn);
      }
    }, () => {
      // The awaited connect path below owns connection errors.
    });
  }
  const tcpConn = await withAbort(
    connect,
    signal,
  );
  if (url.protocol === "http:") {
    if (signal?.aborted) {
      closeConnection(tcpConn);
      throw abortReason(signal);
    }
    return tcpConn;
  }

  const abortHandler = signal === undefined
    ? undefined
    : () => closeConnection(tcpConn);
  if (signal !== undefined && abortHandler !== undefined) {
    signal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    throwIfAborted(signal);
    const tlsConn = await withAbort(
      Deno.startTls(tcpConn, {
        hostname: normalizeHostname(url.hostname),
        alpnProtocols: ["http/1.1"],
      }),
      signal,
    );
    throwIfAborted(signal);
    return tlsConn;
  } catch (error) {
    closeConnection(tcpConn);
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    throw error;
  } finally {
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
};

const serializeHttpRequest = (
  url: URL,
  method: string,
  inputHeaders: HeadersInit | undefined,
  bodyLength: number | undefined,
): string => {
  const headers = new Headers(inputHeaders);
  const requestTarget = `${
    url.pathname === "" ? "/" : url.pathname
  }${url.search}`;
  const lines = [
    `${method} ${requestTarget} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: close",
    "Accept-Encoding: identity",
  ];
  if (bodyLength !== undefined) {
    lines.push(`Content-Length: ${bodyLength}`);
  }
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (
      FORBIDDEN_SERIALIZED_HEADERS.has(normalized) ||
      normalized.startsWith("proxy-")
    ) {
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
};

interface HttpResponseHead {
  status: number;
  statusText: string;
  headers: Headers;
  bodyPrefix: Bytes;
}

const readHttpResponseHead = async (
  conn: Deno.Conn,
  maxResponseHeaderBytes: number,
  signal: AbortSignal | undefined,
  errorLabel: string,
): Promise<HttpResponseHead> => {
  let buffered: Bytes = new Uint8Array();
  let informationalResponses = 0;
  while (true) {
    const headerEnd = findHeaderEnd(buffered);
    if (headerEnd !== -1) {
      if (headerEnd > maxResponseHeaderBytes) {
        break;
      }
      const headerBytes = buffered.slice(0, headerEnd);
      const parsed = parseHttpResponseHead(headerBytes, errorLabel);
      const remainder = buffered.slice(headerEnd + 4);
      if (parsed.status >= 100 && parsed.status < 200) {
        if (parsed.status === 101) {
          throw new Error(
            `${errorLabel} received unsupported HTTP status 101`,
          );
        }
        informationalResponses++;
        if (informationalResponses > MAX_INFORMATIONAL_RESPONSES) {
          throw new Error(
            `${errorLabel} received too many informational responses`,
          );
        }
        buffered = remainder;
        continue;
      }
      return {
        ...parsed,
        bodyPrefix: remainder,
      };
    }
    if (buffered.byteLength > maxResponseHeaderBytes) {
      break;
    }
    const chunk = await readConnChunk(conn, signal);
    if (chunk === undefined) {
      break;
    }
    buffered = concatBytes(buffered, chunk);
  }
  throw new Error(
    `${errorLabel} response headers were incomplete or too large`,
  );
};

const parseHttpResponseHead = (
  headerBytes: Bytes,
  errorLabel: string,
): Omit<HttpResponseHead, "bodyPrefix"> => {
  const headerText = new TextDecoder().decode(headerBytes);
  const lines = headerText.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(
    statusLine,
  );
  if (statusMatch === null) {
    throw new Error(`${errorLabel} received an invalid HTTP status line`);
  }
  const status = Number(statusMatch[1]);
  if (status < 100 || status > 599) {
    throw new Error(`${errorLabel} received unsupported HTTP status ${status}`);
  }
  const headers = new Headers();
  let lastHeaderName: string | undefined;
  for (const line of lines) {
    if (line === "") {
      continue;
    }
    if (/^[ \t]/.test(line) && lastHeaderName !== undefined) {
      headers.set(
        lastHeaderName,
        `${headers.get(lastHeaderName) ?? ""} ${line.trim()}`,
      );
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    headers.append(name, value);
    lastHeaderName = name;
  }
  return {
    status,
    statusText: statusMatch[2] ?? "",
    headers,
  };
};

const findHeaderEnd = (bytes: Bytes): number => {
  for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
    if (
      bytes[index] === 13 && bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 && bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
};

const createHttpResponseBodyStream = (
  conn: Deno.Conn,
  bodyPrefix: Bytes,
  headers: Headers,
  signal: AbortSignal | undefined,
  errorLabel: string,
): ReadableStream<Uint8Array> => {
  let buffered = bodyPrefix;
  let contentLengthRemaining = parseContentLength(headers);
  let chunkBytesRemaining = 0;
  let closed = false;
  let abortHandler: (() => void) | undefined;
  const isChunked = (headers.get("transfer-encoding") ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .includes("chunked");

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
    closeConnection(conn);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal === undefined) {
        return;
      }
      abortHandler = () => {
        close();
        controller.error(abortReason(signal));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    },
    async pull(controller) {
      try {
        throwIfAborted(signal);
        if (isChunked) {
          await pullChunkedBodyChunk({
            conn,
            signal,
            controller,
            close,
            errorLabel,
            get buffered() {
              return buffered;
            },
            set buffered(value) {
              buffered = value;
            },
            get chunkBytesRemaining() {
              return chunkBytesRemaining;
            },
            set chunkBytesRemaining(value) {
              chunkBytesRemaining = value;
            },
          });
          return;
        }
        if (contentLengthRemaining !== undefined) {
          if (contentLengthRemaining <= 0) {
            close();
            controller.close();
            return;
          }
          if (buffered.byteLength === 0) {
            const chunk = await readConnChunk(conn, signal);
            if (chunk === undefined) {
              throw new Error(`${errorLabel} response ended unexpectedly`);
            }
            buffered = chunk;
          }
          const bytesToSend = Math.min(
            buffered.byteLength,
            contentLengthRemaining,
          );
          controller.enqueue(buffered.slice(0, bytesToSend));
          buffered = buffered.slice(bytesToSend);
          contentLengthRemaining -= bytesToSend;
          return;
        }
        if (buffered.byteLength > 0) {
          controller.enqueue(buffered);
          buffered = new Uint8Array();
          return;
        }
        const chunk = await readConnChunk(conn, signal);
        if (chunk === undefined) {
          close();
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
    },
  });
};

interface ChunkedBodyState {
  conn: Deno.Conn;
  signal?: AbortSignal;
  controller: ReadableStreamDefaultController<Uint8Array>;
  close(): void;
  errorLabel: string;
  buffered: Bytes;
  chunkBytesRemaining: number;
}

const pullChunkedBodyChunk = async (
  state: ChunkedBodyState,
): Promise<void> => {
  while (true) {
    if (state.chunkBytesRemaining > 0) {
      await fillBodyBuffer(state, 1);
      const bytesToSend = Math.min(
        state.buffered.byteLength,
        state.chunkBytesRemaining,
      );
      const chunk = state.buffered.slice(0, bytesToSend);
      state.buffered = state.buffered.slice(bytesToSend);
      state.chunkBytesRemaining -= bytesToSend;
      if (state.chunkBytesRemaining === 0) {
        await fillBodyBuffer(state, 2);
        if (state.buffered[0] !== 13 || state.buffered[1] !== 10) {
          throw new Error(
            `${state.errorLabel} received an invalid chunked response`,
          );
        }
        state.buffered = state.buffered.slice(2);
      }
      state.controller.enqueue(chunk);
      return;
    }
    const line = await readChunkedLine(state);
    const chunkSizeText = line.split(";", 1)[0]!.trim();
    if (!/^[0-9a-f]+$/i.test(chunkSizeText)) {
      throw new Error(
        `${state.errorLabel} received an invalid chunked response`,
      );
    }
    const chunkSize = Number.parseInt(chunkSizeText, 16);
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 0) {
      throw new Error(
        `${state.errorLabel} received an invalid chunked response`,
      );
    }
    if (chunkSize === 0) {
      await discardChunkedTrailers(state);
      state.close();
      state.controller.close();
      return;
    }
    state.chunkBytesRemaining = chunkSize;
  }
};

const readChunkedLine = async (state: ChunkedBodyState): Promise<string> => {
  while (true) {
    const lineEnd = findCrlf(state.buffered);
    if (lineEnd !== -1) {
      if (lineEnd > MAX_CHUNKED_LINE_BYTES) {
        throw new Error(
          `${state.errorLabel} chunked line exceeded size limit`,
        );
      }
      const line = new TextDecoder().decode(state.buffered.slice(0, lineEnd));
      state.buffered = state.buffered.slice(lineEnd + 2);
      return line;
    }
    if (state.buffered.byteLength > MAX_CHUNKED_LINE_BYTES + 1) {
      throw new Error(
        `${state.errorLabel} chunked line exceeded size limit`,
      );
    }
    await fillBodyBuffer(state, state.buffered.byteLength + 1);
  }
};

const discardChunkedTrailers = async (
  state: ChunkedBodyState,
): Promise<void> => {
  let trailerBytes = 0;
  let trailerLines = 0;
  while (true) {
    const line = await readChunkedLine(state);
    trailerBytes += textEncoder.encode(line).byteLength + 2;
    if (trailerBytes > MAX_CHUNKED_TRAILER_BYTES) {
      throw new Error(
        `${state.errorLabel} chunked trailers exceeded size limit`,
      );
    }
    if (line === "") {
      return;
    }
    trailerLines += 1;
    if (trailerLines > MAX_CHUNKED_TRAILER_LINES) {
      throw new Error(
        `${state.errorLabel} chunked trailers exceeded line limit`,
      );
    }
  }
};

const fillBodyBuffer = async (
  state: ChunkedBodyState,
  minBytes: number,
): Promise<void> => {
  while (state.buffered.byteLength < minBytes) {
    const chunk = await readConnChunk(state.conn, state.signal);
    if (chunk === undefined) {
      throw new Error(`${state.errorLabel} response ended unexpectedly`);
    }
    state.buffered = concatBytes(state.buffered, chunk);
  }
};

const findCrlf = (bytes: Bytes): number => {
  for (let index = 0; index <= bytes.byteLength - 2; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) {
      return index;
    }
  }
  return -1;
};

const parseContentLength = (headers: Headers): number | undefined => {
  const value = headers.get("content-length");
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const readConnChunk = async (
  conn: Deno.Conn,
  signal?: AbortSignal,
): Promise<Bytes | undefined> => {
  throwIfAborted(signal);
  const buffer = new Uint8Array(16 * 1024);
  try {
    const bytesRead = await withAbort(conn.read(buffer), signal);
    throwIfAborted(signal);
    return bytesRead === null ? undefined : buffer.slice(0, bytesRead);
  } catch (error) {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    throw error;
  }
};

const writeAll = async (
  conn: Deno.Conn,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    throwIfAborted(signal);
    try {
      const written = await withAbort(conn.write(bytes.slice(offset)), signal);
      if (written <= 0) {
        throw new Error("pinned HTTP connection wrote zero bytes");
      }
      offset += written;
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      throw error;
    }
  }
};

const concatBytes = (left: Bytes, right: Bytes): Bytes => {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
};

const closeConnection = (conn: Deno.Conn): void => {
  try {
    conn.close();
  } catch {
    // The peer or abort cleanup may already have closed the connection.
  }
};

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The request was aborted", "AbortError");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
};

const withAbort = <T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  throwIfAborted(signal);
  if (signal === undefined) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? abortReason(signal) : error);
      },
    );
  });
};
