/**
 * Checks that production is up, with a synthetic round trip to the estuary and
 * rapids servers and a name or reachability check for the company hosts they
 * depend on or run beside. Each health request goes to /_health on the
 * configured origin. Successful health-check times stay visible in the healthy
 * and warning states, a red state shows only the hosts that are not good, and
 * a host that answers stays out of the body.
 *
 * The tile stays unknown until the public-site check has received an HTTP
 * response. It does not check production hosts before that independent signal
 * confirms the dashboard's own connectivity.
 *
 * Both servers are on the tailnet. PROD_PROXY routes the health requests
 * through a proxy when the dashboard cannot reach the tailnet directly.
 * Tailnet names live in Tailscale's MagicDNS, which the resolver of a
 * dashboard behind such a proxy does not see, so tailnet hosts are checked
 * through the proxy instead: a host with a health endpoint by its /_health
 * request, and a host without one by a SOCKS5 connect that leaves the name for
 * the proxy to resolve. Every other host is checked with an A and AAAA lookup
 * from the dashboard itself.
 */

import { dashboardConnectivityConfirmed } from "../connectivity.ts";
import { escapeHtml } from "../lib.ts";
import type { Status, Tile, TileView } from "../types.ts";

const HEALTH_PATH = "/_health";
const WARN_LATENCY_MS = 500;
const BAD_LATENCY_MS = 1000;
const TAILNET_SUFFIX = ".ts.net";
// A connect that reaches a host opens and closes a session the host records in
// its own logs, so a host that answers is left alone for this long and counts as
// reachable in between. A connect that reaches nothing leaves nothing behind, so
// a host that does not answer is asked again on the next refresh.
const PROBE_INTERVAL_MS = 3_600_000;
const SOCKS5_VERSION = 5;
const SOCKS5_NO_AUTHENTICATION = 0;
const SOCKS5_CONNECT = 1;
const SOCKS5_DOMAIN_NAME = 3;
const SOCKS5_SUCCEEDED = 0;
const SOCKS5_DEFAULT_PORT = 1080;
const STATUS_DOT: Record<Status, string> = {
  good: "green",
  warn: "amber",
  bad: "red",
  unknown: "gray",
};
const STATUS_RANK: Record<Status, number> = {
  good: 0,
  unknown: 1,
  warn: 2,
  bad: 3,
};

type HealthTargetName = "estuary" | "rapids";
type CreateHttpClient = typeof Deno.createHttpClient;
type HttpClientOptions = Parameters<CreateHttpClient>[0];
type ProxyFetchInit = RequestInit & { client?: Deno.HttpClient };
type ResolveDns = (
  query: string,
  recordType: "A" | "AAAA",
) => Promise<readonly string[]>;

/** The part of a TCP connection the SOCKS5 exchange below uses. */
export interface ProxyStream {
  read(buffer: Uint8Array): Promise<number | null>;
  write(buffer: Uint8Array): Promise<number>;
  close(): void;
}
type OpenProxyStream = (
  options: Deno.ConnectOptions,
) => Promise<ProxyStream>;

interface Target {
  name: string;
  origin?: string;
  href?: string;
  hostname: string;
  port: number;
  health: HealthTargetName | null;
}

interface Check {
  status: Status;
  detail: string;
  // Set when the check found no host at the other end at all, as opposed to
  // finding one that answered badly or slowly. The headline names these.
  down?: true;
  headline?: {
    text: string;
    priority: number;
    magnitude: number;
  };
}

interface TargetResult {
  target: Target;
  http: Check;
  reach: Check;
  status: Status;
}

let createHttpClient: CreateHttpClient = Deno.createHttpClient;
let resolveDns: ResolveDns = (query, recordType) =>
  Deno.resolveDns(query, recordType);
let openProxyStream: OpenProxyStream = Deno.connect;
const reachedAt = new Map<string, number>();

export function setProdUptimeHttpClientFactoryForTest(
  factory: CreateHttpClient,
): () => void {
  const previous = createHttpClient;
  createHttpClient = factory;
  return () => {
    createHttpClient = previous;
  };
}

export function setProdUptimeDnsResolverForTest(
  resolver: ResolveDns,
): () => void {
  const previous = resolveDns;
  resolveDns = resolver;
  return () => {
    resolveDns = previous;
  };
}

export function setProdUptimeProxyStreamOpenerForTest(
  opener: OpenProxyStream,
): () => void {
  const previous = openProxyStream;
  openProxyStream = opener;
  reachedAt.clear();
  return () => {
    openProxyStream = previous;
    reachedAt.clear();
  };
}

function proxyUrl(proxy: string): URL {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch (cause) {
    throw new TypeError(`invalid PROD_PROXY URL: ${proxy}`, { cause });
  }

  if (url.username !== "" || url.password !== "") {
    throw new TypeError("PROD_PROXY URL must not contain credentials");
  }
  if (!isSocks5(url) && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`unsupported PROD_PROXY URL scheme: ${url.protocol}`);
  }
  return url;
}

function optionsForProxy(url: URL, proxy: string): HttpClientOptions {
  return isSocks5(url)
    ? { proxy: { transport: "socks5", url: proxy } }
    : { proxy: { url: proxy } };
}

function isSocks5(url: URL): boolean {
  return url.protocol === "socks5:" || url.protocol === "socks5h:";
}

function isTailnetName(hostname: string): boolean {
  return hostname.endsWith(TAILNET_SUFFIX);
}

function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "http:" ? 80 : 443;
}

function healthTarget(name: HealthTargetName, value: string): Target {
  const url = new URL(value);
  return {
    name,
    origin: url.origin,
    href: url.origin,
    hostname: url.hostname,
    port: portOf(url),
    health: name,
  };
}

function hostTarget(
  name: string,
  value: string,
  port: number,
  href?: string,
): Target {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  return {
    name,
    hostname: url.hostname,
    port: url.port === "" ? port : Number(url.port),
    href,
    health: null,
  };
}

function worstStatus(statuses: readonly Status[]): Status {
  return statuses.reduce<Status>(
    (worst, status) =>
      STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst,
    "good",
  );
}

// A host nothing answered for is the plainest thing the tile can say, so it
// takes the headline over any host that answered.
function downHeadline(results: readonly TargetResult[]): string | undefined {
  const down = results.filter(
    (result) => result.http.down === true || result.reach.down === true,
  );
  if (down.length === 0) return undefined;
  return down.length === 1
    ? `${down[0].target.name} down`
    : `${down.length} hosts down`;
}

function worstHeadline(results: readonly TargetResult[]): string | undefined {
  const candidates = results.flatMap((result) => [result.http, result.reach])
    .filter((check) => check.headline !== undefined);
  candidates.sort((a, b) =>
    STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
    (b.headline?.priority ?? 0) - (a.headline?.priority ?? 0) ||
    (b.headline?.magnitude ?? 0) - (a.headline?.magnitude ?? 0)
  );
  return candidates[0]?.headline?.text;
}

async function writeAll(
  stream: ProxyStream,
  bytes: Uint8Array,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await stream.write(bytes.subarray(written));
  }
}

async function readExactly(
  stream: ProxyStream,
  count: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(count);
  let filled = 0;
  while (filled < count) {
    const read = await stream.read(bytes.subarray(filled));
    if (read === null) throw new Error("the proxy closed the connection");
    filled += read;
  }
  return bytes;
}

// Ask a SOCKS5 proxy to open a connection to a host by name, which leaves both
// the lookup and the dial to the proxy. Tailscale answers with one failure code
// for a name it cannot resolve and for a host it cannot reach, so this reports
// the pair of them together.
async function reachesThroughSocks5(
  proxy: URL,
  hostname: string,
  port: number,
): Promise<boolean> {
  const name = new TextEncoder().encode(hostname);
  if (name.length > 255) return false;
  const stream = await openProxyStream({
    hostname: proxy.hostname,
    port: proxy.port === "" ? SOCKS5_DEFAULT_PORT : Number(proxy.port),
  });
  try {
    await writeAll(
      stream,
      new Uint8Array([SOCKS5_VERSION, 1, SOCKS5_NO_AUTHENTICATION]),
    );
    const greeting = await readExactly(stream, 2);
    if (
      greeting[0] !== SOCKS5_VERSION ||
      greeting[1] !== SOCKS5_NO_AUTHENTICATION
    ) {
      return false;
    }

    const request = new Uint8Array(7 + name.length);
    request.set([
      SOCKS5_VERSION,
      SOCKS5_CONNECT,
      0,
      SOCKS5_DOMAIN_NAME,
      name.length,
    ]);
    request.set(name, 5);
    request[5 + name.length] = port >> 8;
    request[6 + name.length] = port & 0xff;
    await writeAll(stream, request);

    const reply = await readExactly(stream, 2);
    return reply[0] === SOCKS5_VERSION && reply[1] === SOCKS5_SUCCEEDED;
  } finally {
    stream.close();
  }
}

async function checkReach(
  target: Target,
  proxy: URL | undefined,
): Promise<Check> {
  if (proxy === undefined || !isTailnetName(target.hostname)) {
    return checkDns(target.hostname);
  }
  // The health request travels the same proxy and covers the same ground.
  if (target.health !== null) return { status: "good", detail: "" };
  if (!isSocks5(proxy)) {
    return {
      status: "unknown",
      detail: "no proxy route",
      headline: { text: "no proxy route", priority: 3, magnitude: 0 },
    };
  }

  const key = `${proxy.protocol}//${proxy.host}|${target.hostname}:${target.port}`;
  const now = Date.now();
  const previous = reachedAt.get(key);
  if (previous !== undefined && now - previous < PROBE_INTERVAL_MS) {
    return { status: "good", detail: "" };
  }

  let reached = false;
  try {
    reached = await reachesThroughSocks5(proxy, target.hostname, target.port);
  } catch {
    // An exchange that breaks down reads the same as a connection refused.
  }
  if (!reached) {
    reachedAt.delete(key);
    return { status: "bad", detail: "unreachable", down: true };
  }
  reachedAt.set(key, now);
  return { status: "good", detail: "" };
}

async function checkDns(hostname: string): Promise<Check> {
  const answers = await Promise.allSettled([
    resolveDns(hostname, "A"),
    resolveDns(hostname, "AAAA"),
  ]);
  const resolves = answers.some((answer) =>
    answer.status === "fulfilled" && answer.value.length > 0
  );
  if (resolves) return { status: "good", detail: "" };
  const missing = answers.every((answer) =>
    answer.status === "fulfilled"
      ? answer.value.length === 0
      : answer.reason instanceof Deno.errors.NotFound
  );
  if (missing) return { status: "bad", detail: "DNS down", down: true };
  return {
    status: "warn",
    detail: "DNS unknown",
    headline: { text: "DNS unknown", priority: 3, magnitude: 0 },
  };
}

async function checkHttp(
  target: Target,
  client: Deno.HttpClient | undefined,
  invalidProxy: boolean,
): Promise<Check> {
  if (target.health === null || target.origin === undefined) {
    return { status: "good", detail: "" };
  }
  if (invalidProxy) {
    return {
      status: "warn",
      detail: "invalid proxy",
      headline: { text: "invalid proxy", priority: 2, magnitude: 0 },
    };
  }

  try {
    const t0 = Date.now();
    const init: ProxyFetchInit = {
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    };
    if (client !== undefined) init.client = client;
    const res = await fetch(`${target.origin}${HEALTH_PATH}`, init);
    const ms = Date.now() - t0;
    try {
      await res.body?.cancel();
    } catch {
      // A received status establishes reachability when body cleanup fails.
    }
    const status: Status = res.status !== 200 || ms > BAD_LATENCY_MS
      ? "bad"
      : ms > WARN_LATENCY_MS
      ? "warn"
      : "good";
    return {
      status,
      detail: res.status === 200 ? `${ms} ms` : `HTTP ${res.status} · ${ms} ms`,
      headline: res.status !== 200
        ? { text: `HTTP ${res.status}`, priority: 2, magnitude: res.status }
        : ms > WARN_LATENCY_MS
        ? { text: `${ms} ms`, priority: 1, magnitude: ms }
        : undefined,
    };
  } catch {
    return { status: "bad", detail: "unreachable", down: true };
  }
}

function resultRow(result: TargetResult): string {
  const target = result.target;
  const details = [result.http.detail, result.reach.detail].filter(Boolean)
    .join(" · ");
  const content =
    `<span style="display:inline-flex;align-items:center;gap:6px;font-weight:600"><span class="dot ${
      STATUS_DOT[result.status]
    }"></span>${
      escapeHtml(target.name)
    }</span><span style="color:var(--text-muted);font-variant-numeric:tabular-nums">${
      escapeHtml(details)
    }</span>`;
  return target.href === undefined
    ? content
    : `<a href="${
      escapeHtml(target.href)
    }" target="_blank" rel="noopener" style="display:contents;color:inherit;text-decoration:none">${content}</a>`;
}

function view(results: readonly TargetResult[]): TileView {
  const status = worstStatus(results.map((result) => result.status));
  const headline = downHeadline(results) ?? worstHeadline(results);
  const visible = results.filter(
    (result) =>
      result.status !== "good" ||
      (status !== "bad" && result.target.health !== null),
  );
  const rows = visible.map(resultRow).join("");
  return {
    label: "production",
    status,
    value: headline ?? `${results.length}/${results.length} hosts up`,
    extra: rows === ""
      ? undefined
      : `<div style="display:grid;grid-template-columns:auto 1fr;gap:7px 10px;margin-top:11px;font-size:12px;line-height:1.35">${rows}</div>`,
  };
}

export const prodUptime: Tile = {
  id: "prod-uptime",
  intervalMs: 30_000,
  async collect(ctx): Promise<TileView> {
    if (!dashboardConnectivityConfirmed()) {
      return {
        label: "production",
        status: "unknown",
        value: "—",
        sub: "waiting for connectivity",
      };
    }
    const targets = [
      healthTarget(
        "estuary",
        ctx.env("ESTUARY_URL") ?? ctx.env("PROD_URL") ??
          "https://estuary.saga-castor.ts.net",
      ),
      healthTarget(
        "rapids",
        ctx.env("RAPIDS_URL") ?? "https://rapids.saga-castor.ts.net",
      ),
      hostTarget(
        "bastion",
        ctx.env("BASTION_HOST") ?? "bastion.saga-castor.ts.net",
        22,
      ),
      hostTarget(
        "prod shell",
        "production.commontools.dev",
        443,
        "https://production.commontools.dev",
      ),
      hostTarget(
        "stage shell",
        "staging.commontools.dev",
        443,
        "https://staging.commontools.dev",
      ),
      hostTarget(
        "LLM",
        "llm.stage.commontools.dev",
        443,
        "https://llm.stage.commontools.dev",
      ),
      hostTarget(
        "sandbox",
        "sandbox.stage.commontools.dev",
        443,
        "https://sandbox.stage.commontools.dev",
      ),
    ];
    const proxy = ctx.env("PROD_PROXY");
    let parsedProxy: URL | undefined;
    let client: Deno.HttpClient | undefined;
    let invalidProxy = false;
    try {
      if (proxy !== undefined) {
        parsedProxy = proxyUrl(proxy);
        client = createHttpClient(optionsForProxy(parsedProxy, proxy));
      }
    } catch {
      parsedProxy = undefined;
      invalidProxy = true;
    }

    try {
      const results = await Promise.all(targets.map(async (target) => {
        const [http, reach] = await Promise.all([
          checkHttp(target, client, invalidProxy),
          checkReach(target, parsedProxy),
        ]);
        return {
          target,
          http,
          reach,
          status: worstStatus([http.status, reach.status]),
        };
      }));
      return view(results);
    } finally {
      client?.close();
    }
  },
};
