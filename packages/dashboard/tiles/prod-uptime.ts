// production uptime: a synthetic round-trip check of the production server. Times
// the fetch and maps reachability + latency to a status. A single unreachable
// check is treated as "can't tell" (calm gray), not an outage — only a sustained
// run of failures escalates to a red "down" alarm, so a network blip on the
// dashboard's side doesn't cry wolf. An HTTP 5xx (reached but erroring) is a real
// bad state immediately, since that isn't a connectivity blip.
//
// PROD_URL is the production server: an origin, not the thing to fetch. The tile
// checks HEALTH_PATH on it, because that answers only while the server is really
// serving, and links to the origin, because that is what someone clicking a tile
// wants to open. The default is estuary, which is the production toolshed.
//
// The old default, production.commontools.dev, is not the server: it is the shell,
// a static site in a GCS bucket (tofu/shell/README.md). It has no health endpoint,
// and its index page answers 200 for as long as Google's object storage is up —
// which is to say, through a total outage of the server behind it.
//
// Estuary is on the tailnet. A dashboard that cannot reach the tailnet reads it as
// unreachable, and a sustained run of that is a red "down" about the dashboard
// rather than about production, so such a deployment must route this check over
// the tailnet with PROD_PROXY or point PROD_URL at another truthful health source.
import type { Status, Tile, TileView } from "../types.ts";

const FAIL_THRESHOLD = 3; // consecutive unreachable checks before declaring "down"
const HEALTH_PATH = "/_health";
let fails = 0;

type CreateHttpClient = typeof Deno.createHttpClient;
type ProxyFetchInit = RequestInit & { client?: Deno.HttpClient };

let createHttpClient: CreateHttpClient = Deno.createHttpClient;

export function setProdUptimeHttpClientFactoryForTest(
  factory: CreateHttpClient,
): () => void {
  const previous = createHttpClient;
  createHttpClient = factory;
  return () => {
    createHttpClient = previous;
  };
}

function clientForProxy(proxy: string): Deno.HttpClient {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch (cause) {
    throw new TypeError(`invalid PROD_PROXY URL: ${proxy}`, { cause });
  }

  if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
    return createHttpClient({ proxy: { transport: "socks5", url: proxy } });
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return createHttpClient({ proxy: { url: proxy } });
  }

  throw new TypeError(`unsupported PROD_PROXY URL scheme: ${url.protocol}`);
}

export const prodUptime: Tile = {
  id: "prod-uptime",
  intervalMs: 30_000,
  async collect(ctx): Promise<TileView> {
    const origin =
      new URL(ctx.env("PROD_URL") ?? "https://estuary.saga-castor.ts.net")
        .origin;
    const proxy = ctx.env("PROD_PROXY");
    const client = proxy === undefined ? undefined : clientForProxy(proxy);
    const url = `${origin}${HEALTH_PATH}`;
    const host = new URL(origin).host;
    const drill = { href: origin, hint: "open ↗" };

    try {
      const t0 = Date.now();
      const init: ProxyFetchInit = {
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      };
      if (client !== undefined) init.client = client;
      const res = await fetch(url, init);
      const ms = Date.now() - t0;
      await res.arrayBuffer();
      fails = 0; // reachable — reset the outage counter

      const status: Status = res.status >= 500
        ? "bad"
        : res.status >= 400 || ms > 2500
        ? "warn"
        : "good";
      return {
        ...drill,
        label: "production",
        status,
        value: res.status >= 500 ? "erroring" : `${ms} ms`,
        sub: `HTTP ${res.status} · ${host}`,
      };
    } catch {
      fails++;
      const status: Status = fails >= FAIL_THRESHOLD ? "bad" : "unknown";
      return {
        ...drill,
        label: "production",
        status,
        value: fails >= FAIL_THRESHOLD ? "down" : "—",
        sub: `unreachable · ${host}`,
      };
    } finally {
      client?.close();
    }
  },
};
