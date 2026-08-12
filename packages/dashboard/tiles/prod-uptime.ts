// production uptime: synthetic round-trip checks for the estuary and rapids
// servers, plus DNS checks for the company hosts they depend on or run beside.
// Each health request goes to /_health on the configured origin. Successful
// health-check times stay visible in healthy and warning states. Red states show
// only non-good hosts. Resolved DNS-only hosts stay out of the body.
//
// Both servers are on the tailnet. PROD_PROXY routes the health requests through
// a proxy when the dashboard cannot reach the tailnet directly. The DNS result
// reports whether the dashboard host resolves an A or AAAA record itself.
import { escapeHtml } from "../lib.ts";
import type { Status, Tile, TileView } from "../types.ts";

const HEALTH_PATH = "/_health";
const WARN_LATENCY_MS = 275;
const BAD_LATENCY_MS = 500;
const STATUS_DOT: Record<Status, string> = {
  good: "green",
  warn: "amber",
  bad: "red",
  unknown: "grey",
};

type HealthTargetName = "estuary" | "rapids";
type CreateHttpClient = typeof Deno.createHttpClient;
type HttpClientOptions = Parameters<CreateHttpClient>[0];
type ProxyFetchInit = RequestInit & { client?: Deno.HttpClient };
type ResolveDns = (
  query: string,
  recordType: "A" | "AAAA",
) => Promise<readonly string[]>;

interface Target {
  name: string;
  origin?: string;
  href?: string;
  hostname: string;
  health: HealthTargetName | null;
}

interface Check {
  status: Status;
  detail: string;
  headline?: {
    text: string;
    priority: number;
    magnitude: number;
  };
}

interface TargetResult {
  target: Target;
  http: Check;
  dns: Check;
  status: Status;
}

let createHttpClient: CreateHttpClient = Deno.createHttpClient;
let resolveDns: ResolveDns = (query, recordType) =>
  Deno.resolveDns(query, recordType);

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

function optionsForProxy(proxy: string): HttpClientOptions {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch (cause) {
    throw new TypeError(`invalid PROD_PROXY URL: ${proxy}`, { cause });
  }

  if (url.username !== "" || url.password !== "") {
    throw new TypeError("PROD_PROXY URL must not contain credentials");
  }
  if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
    return { proxy: { transport: "socks5", url: proxy } };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { proxy: { url: proxy } };
  }

  throw new TypeError(`unsupported PROD_PROXY URL scheme: ${url.protocol}`);
}

function healthTarget(name: HealthTargetName, value: string): Target {
  const url = new URL(value);
  return {
    name,
    origin: url.origin,
    href: url.origin,
    hostname: url.hostname,
    health: name,
  };
}

function dnsTarget(name: string, value: string, href?: string): Target {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  return { name, hostname: url.hostname, href, health: null };
}

function worstStatus(statuses: readonly Status[]): Status {
  if (statuses.includes("bad")) return "bad";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("unknown")) return "unknown";
  return "good";
}

function worstHeadline(results: readonly TargetResult[]): string | undefined {
  const statusRank: Record<Status, number> = {
    good: 0,
    unknown: 1,
    warn: 2,
    bad: 3,
  };
  const candidates = results.flatMap((result) => [result.http, result.dns])
    .filter((check) => check.headline !== undefined);
  candidates.sort((a, b) =>
    statusRank[b.status] - statusRank[a.status] ||
    (b.headline?.priority ?? 0) - (a.headline?.priority ?? 0) ||
    (b.headline?.magnitude ?? 0) - (a.headline?.magnitude ?? 0)
  );
  return candidates[0]?.headline?.text;
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
  return {
    status: missing ? "bad" : "warn",
    detail: missing ? "DNS down" : "DNS unknown",
    headline: {
      text: missing ? "DNS down" : "DNS unknown",
      priority: 3,
      magnitude: 0,
    },
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
    return {
      status: "warn",
      detail: "unreachable",
      headline: { text: "unreachable", priority: 2, magnitude: 0 },
    };
  }
}

function resultRow(result: TargetResult): string {
  const target = result.target;
  const details = [result.http.detail, result.dns.detail].filter(Boolean).join(
    " · ",
  );
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
  const headline = worstHeadline(results);
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
      dnsTarget(
        "bastion",
        ctx.env("BASTION_HOST") ?? "bastion.saga-castor.ts.net",
      ),
      dnsTarget(
        "prod shell",
        "production.commontools.dev",
        "https://production.commontools.dev",
      ),
      dnsTarget(
        "stage shell",
        "staging.commontools.dev",
        "https://staging.commontools.dev",
      ),
      dnsTarget(
        "LLM",
        "llm.stage.commontools.dev",
        "https://llm.stage.commontools.dev",
      ),
      dnsTarget(
        "sandbox",
        "sandbox.stage.commontools.dev",
        "https://sandbox.stage.commontools.dev",
      ),
    ];
    const proxy = ctx.env("PROD_PROXY");
    let client: Deno.HttpClient | undefined;
    let invalidProxy = false;
    try {
      client = proxy === undefined
        ? undefined
        : createHttpClient(optionsForProxy(proxy));
    } catch {
      invalidProxy = true;
    }

    try {
      const results = await Promise.all(targets.map(async (target) => {
        const [http, dns] = await Promise.all([
          target.health === null
            ? Promise.resolve({ status: "good" as const, detail: "" })
            : checkHttp(target, client, invalidProxy),
          checkDns(target.hostname),
        ]);
        return {
          target,
          http,
          dns,
          status: worstStatus([http.status, dns.status]),
        };
      }));
      return view(results);
    } finally {
      client?.close();
    }
  },
};
