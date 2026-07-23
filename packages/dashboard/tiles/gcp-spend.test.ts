// Cloud spend tile: collect(ctx) -> TileView against a stubbed BigQuery REST API.
// No network — fetch is replaced for the duration of each call and restored after,
// so the two requests the tile makes (a metadata access token, then jobs.query)
// answer from canned JSON.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx } from "../types.ts";
import { METADATA_TOKEN_URL } from "../gcp.ts";
import { gcpSpend } from "./gcp-spend.ts";

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

interface Call {
  url: string;
  body: string;
}

// Swap in a fetch that answers from `reply`, run `fn`, then put the real one back.
// Returns what the tile produced alongside the requests it made.
async function withFetch<T>(
  reply: (url: string) => Response,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: Call[] }> {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return Promise.resolve(reply(String(input)));
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

// The metadata server hands out the workload's token; jobs.query returns `rows`
// in BigQuery's cell-wrapped shape.
const bigQueryStub = (rows: (string | null)[][]) => (url: string): Response =>
  url === METADATA_TOKEN_URL
    ? json({ access_token: "token" })
    : json({ jobComplete: true, rows: rows.map((r) => ({ f: r.map((v) => ({ v })) })) });

const TABLE = "billing-proj.billing.gcp_billing_export_v1_XXXX";

Deno.test("cloud spend: no GCP_BILLING_TABLE -> gray, and names the env it wants", async () => {
  const v = await gcpSpend.collect(ctx({}));
  assertEquals(v.label, "cloud spend");
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertEquals(v.sub, "set GCP_BILLING_TABLE");
});

Deno.test("cloud spend: a table id that isn't a plain identifier is refused before any query", async () => {
  // The table is interpolated into the SQL, so anything that could close the
  // backtick quote is rejected rather than sent.
  const { result, calls } = await withFetch(
    bigQueryStub([["10"]]),
    () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: "proj.ds.t` WHERE 1=1 UNION SELECT * FROM `secrets.t" })),
  );
  assertEquals(result.status, "unknown");
  assertEquals(result.value, "—");
  assertEquals(result.sub, "invalid GCP_BILLING_TABLE");
  assertEquals(calls.length, 0, "nothing is sent for a table id that failed the check");
});

Deno.test("cloud spend: yesterday's total for the table's own project, under budget -> good", async () => {
  const { result, calls } = await withFetch(
    bigQueryStub([["412.34"]]),
    () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE, GCP_DAILY_BUDGET: "500" })),
  );
  assertEquals(result.status, "good"); // 412.34 <= 500
  assertEquals(result.value, "$412/day");
  assertEquals(result.sub, "yesterday · billing account spend");

  // The query runs in the project the table names, which is where the service
  // account holds Job User.
  const query = calls.find((c) => c.url.includes("bigquery.googleapis.com"))!;
  assertStringIncludes(query.url, "/projects/billing-proj/queries");
  const sql = JSON.parse(query.body).query as string;
  assertStringIncludes(sql, "SUM(cost)");
  assertStringIncludes(sql, "`" + TABLE + "`");
  assertStringIncludes(sql, "DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)"); // the last full UTC day
});

Deno.test("cloud spend: over budget by up to a quarter is warn, beyond that bad; no budget never alarms", async () => {
  const at = async (budget: Record<string, string>) =>
    (await withFetch(
      bigQueryStub([["500"]]),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE, ...budget })),
    )).result;
  assertEquals((await at({ GCP_DAILY_BUDGET: "500" })).status, "good"); // exactly on budget
  assertEquals((await at({ GCP_DAILY_BUDGET: "400" })).status, "warn"); // 500 = 1.25x of 400
  assertEquals((await at({ GCP_DAILY_BUDGET: "399" })).status, "bad");
  assertEquals((await at({})).status, "good"); // an unset budget can't be exceeded
  assertEquals((await at({})).value, "$500/day");
});

Deno.test("cloud spend: an empty SUM is 'no billing data yet', not a $0 day", async () => {
  // SUM over a day the export hasn't landed for is NULL, which BigQuery returns as
  // an empty cell. Reading that as zero would claim a real $0 of spend.
  const empty = await withFetch(
    bigQueryStub([[null]]),
    () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE, GCP_DAILY_BUDGET: "1" })),
  );
  assertEquals(empty.result.status, "unknown");
  assertEquals(empty.result.value, "—");
  assertEquals(empty.result.sub, "no billing data yet");
  // A response with no row at all reads the same way.
  const norows = await withFetch(
    bigQueryStub([]),
    () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
  );
  assertEquals(norows.result.status, "unknown");
  assertEquals(norows.result.sub, "no billing data yet");
});

Deno.test("cloud spend: a cost cell that isn't a number -> gray, never a figure", async () => {
  const { result } = await withFetch(
    bigQueryStub([["not-a-number"]]),
    () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
  );
  assertEquals(result.status, "unknown");
  assertEquals(result.value, "—");
  assertEquals(result.sub, "unavailable — check credentials");
});

Deno.test("cloud spend: an unreachable source grays out rather than going red or green", async () => {
  // BigQuery refuses the query: gray with a hint at credentials, not a red tile and
  // not a green $0.
  const denied = await withFetch(
    (url) => url === METADATA_TOKEN_URL ? json({ access_token: "token" }) : new Response("no", { status: 403 }),
    () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE, GCP_DAILY_BUDGET: "500" })),
  );
  assertEquals(denied.result.status, "unknown");
  assertEquals(denied.result.value, "—");
  assertEquals(denied.result.sub, "unavailable — check credentials");

  // No token to be had at all — the same gray.
  const noToken = await withFetch(
    () => new Response("{}", { status: 500 }),
    () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
  );
  assertEquals(noToken.result.status, "unknown");
  assertEquals(noToken.result.sub, "unavailable — check credentials");
  assert(!(noToken.result.value ?? "").includes("$"), "a dead source never reports a figure");
});
