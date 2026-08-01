// Cloud spend tile tests. The clock and BigQuery REST responses are fixed, so
// projections and highlighted chart windows are deterministic.
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

async function withFetch<T>(
  reply: (url: string) => Response,
  fn: () => Promise<T>,
  now = "2026-01-10T09:00:00Z",
): Promise<{ result: T; calls: Call[] }> {
  const RealDate = Date;
  const realFetch = globalThis.fetch;
  const fixed = RealDate.parse(now);
  const calls: Call[] = [];
  globalThis.Date = class extends RealDate {
    constructor(...args: unknown[]) {
      super(args.length === 0 ? fixed : (args[0] as number));
    }
  } as DateConstructor;
  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ""),
    });
    return Promise.resolve(reply(String(input)));
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.Date = RealDate;
    globalThis.fetch = realFetch;
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const bigQueryStub = (rows: (string | null)[][]) => (url: string): Response =>
  url === METADATA_TOKEN_URL ? json({ access_token: "token" }) : json({
    jobComplete: true,
    rows: rows.map((row) => ({
      f: row.map((value) => ({ v: value })),
    })),
  });

const DAY = 86_400_000;
const TABLE = "billing-proj.billing.gcp_billing_export_v1_XXXX";

// One row per day, in the shape the query returns: the day, its cost before
// credits, the credit that came off it (negative, as the export records it), and
// the seconds-epoch time the export last added to that day. These fixtures export
// each day eight hours in, so every day but the newest has a later day written
// after it, which is what marks a day finished.
const exportedAt = (day: string) => (Date.parse(`${day}T08:00:00Z`) / 1000);

function dailyRows(
  first: string,
  last: string,
  amount: (day: string) => number,
  credit: (day: string) => number = () => 0,
): string[][] {
  const rows: string[][] = [];
  for (
    let time = Date.parse(`${first}T00:00:00Z`);
    time <= Date.parse(`${last}T00:00:00Z`);
    time += DAY
  ) {
    const day = new Date(time).toISOString().slice(0, 10);
    rows.push([
      day,
      String(amount(day)),
      String(credit(day)),
      String(exportedAt(day)),
    ]);
  }
  return rows;
}

// Through to today, which the export is still writing: the newest finished day
// is 2026-01-09, and today's own partial cost is $5.
const earlyMonthRows = (credit: (day: string) => number = () => 0) =>
  dailyRows(
    "2025-11-26",
    "2026-01-10",
    (day) => day === "2026-01-10" ? 5 : day.startsWith("2026-01") ? 20 : 10,
    credit,
  );

Deno.test(
  "cloud spend: no GCP_BILLING_TABLE is gray and names the setting",
  async () => {
    const view = await gcpSpend.collect(ctx({}));
    assertEquals(view.label, "cloud spend");
    assertEquals(view.status, "unknown");
    assertEquals(view.value, "—");
    assertEquals(view.sub, "set GCP_BILLING_TABLE");
  },
);

Deno.test(
  "cloud spend: an unsafe table id is refused before any query",
  async () => {
    const { result, calls } = await withFetch(
      bigQueryStub([["2026-01-09", "10", "0"]]),
      () =>
        gcpSpend.collect(
          ctx({
            GCP_BILLING_TABLE: "proj.ds.t` WHERE 1=1 UNION SELECT * FROM `secrets.t",
          }),
        ),
    );
    assertEquals(result.status, "unknown");
    assertEquals(result.value, "—");
    assertEquals(result.sub, "invalid GCP_BILLING_TABLE");
    assertEquals(calls.length, 0);
  },
);

Deno.test(
  "cloud spend: projects a month from MTD and the prior tail, with that window highlighted",
  async () => {
    const { result, calls } = await withFetch(
      bigQueryStub(earlyMonthRows()),
      () =>
        gcpSpend.collect(
          ctx({
            GCP_BILLING_TABLE: TABLE,
            GCP_DAILY_BUDGET: "17",
          }),
        ),
    );

    // Nine finished January days at $20 plus five December days at $10 form
    // the 14-day rate: $230 / 14 * 31 = about $509. Today's $5 is in the
    // month-to-date total and out of the rate.
    assertEquals(result.status, "good");
    assertEquals(result.value, "~$509/mo");
    assertEquals(
      result.aside,
      '<span class="hmtd">$185 MTD</span>',
    );
    assertEquals(result.sub, "billing account spend");
    assertEquals(result.duration, 45 * DAY);

    const polylines = [
      ...(result.extra ?? "").matchAll(
        /<polyline points="([^"]+)"/g,
      ),
    ];
    assertEquals(polylines.length, 2);
    assertEquals(polylines[1][1].split(" ").length, 14);

    const query = calls.find((call) => call.url.includes("bigquery.googleapis.com"));
    assert(query);
    assertStringIncludes(
      query.url,
      "/projects/billing-proj/queries",
    );
    const sql = JSON.parse(query.body).query as string;
    assertStringIncludes(sql, "SUM(cost)");
    assertStringIncludes(
      sql,
      "SUM((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit))",
    );
    assertStringIncludes(sql, `\`${TABLE}\``);
    assertStringIncludes(sql, "INTERVAL 45 DAY");
    assertStringIncludes(
      sql,
      "DATE(usage_start_time) <= CURRENT_DATE()",
    );
    assertStringIncludes(sql, "GROUP BY day ORDER BY day");
  },
);

Deno.test(
  "cloud spend: credits come off every figure the tile reports",
  async () => {
    // A quarter off every day: $20 days cost $15, $10 days cost $7.50, and
    // today's $5 so far costs $3.75. The tile reports only those amounts.
    const { result } = await withFetch(
      bigQueryStub(
        earlyMonthRows((day) =>
          day === "2026-01-10" ? -1.25 : day.startsWith("2026-01") ? -5 : -2.5
        ),
      ),
      () =>
        gcpSpend.collect(
          ctx({
            GCP_BILLING_TABLE: TABLE,
            GCP_DAILY_BUDGET: "17",
          }),
        ),
    );

    // The same 14-day window, after credits: nine January days at $15 plus five
    // December days at $7.50 is $172.50 / 14 * 31 = about $382.
    assertEquals(result.value, "~$382/mo");
    assertEquals(
      result.aside,
      '<span class="hmtd">$139 MTD</span>',
    );
    assertEquals(result.sub, "billing account spend");
    // One line, for what the account pays. The credit is not a figure the tile
    // reports, so nothing on it names or charts the cost before credits.
    const polylines = [
      ...(result.extra ?? "").matchAll(/<polyline points="([^"]+)"/g),
    ];
    assertEquals(polylines.length, 2);
    assert(!(result.extra ?? "").includes("$185"));
  },
);

Deno.test(
  "cloud spend: the monthly estimate is judged against the configured daily rate",
  async () => {
    const at = async (dailyBudget?: string) =>
      (await withFetch(
        bigQueryStub(earlyMonthRows()),
        () =>
          gcpSpend.collect(
            ctx({
              GCP_BILLING_TABLE: TABLE,
              ...(dailyBudget === undefined ? {} : { GCP_DAILY_BUDGET: dailyBudget }),
            }),
          ),
      )).result;

    assertEquals((await at("17")).status, "good");
    assertEquals((await at("16")).status, "warn");
    assertEquals((await at("13")).status, "bad");
    assertEquals((await at()).status, "good");
  },
);

Deno.test(
  "cloud spend: the first day of a month estimates entirely from the prior fortnight",
  async () => {
    const { result } = await withFetch(
      bigQueryStub(
        [
          ...dailyRows(
            "2025-11-17",
            "2025-12-31",
            () => 10,
          ),
          ["2026-01-01", "7", "0", String(exportedAt("2026-01-01"))],
        ],
      ),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
      "2026-01-01T09:00:00Z",
    );

    assertEquals(result.value, "~$310/mo");
    assertEquals(
      result.aside,
      '<span class="hmtd">$7 MTD</span>',
    );
    assertEquals(result.duration, 45 * DAY);
    const polylines = [
      ...(result.extra ?? "").matchAll(
        /<polyline points="([^"]+)"/g,
      ),
    ];
    assertEquals(polylines[1][1].split(" ").length, 14);
  },
);

Deno.test(
  "cloud spend: a short export history does not invent earlier zero-cost days",
  async () => {
    const { result } = await withFetch(
      bigQueryStub(dailyRows("2026-01-09", "2026-01-10", () => 20)),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
    );

    // One finished day at $20 rates the month; today's $20 so far is only part
    // of the month-to-date total, and one day is too few to chart.
    assertEquals(result.value, "~$620/mo");
    assertEquals(
      result.aside,
      '<span class="hmtd">$40 MTD</span>',
    );
    assertEquals(result.duration, 0);
    assertEquals(result.extra, "");
  },
);

Deno.test(
  "cloud spend: no returned days means billing data has not arrived",
  async () => {
    const { result } = await withFetch(
      bigQueryStub([]),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
    );
    assertEquals(result.status, "unknown");
    assertEquals(result.value, "—");
    assertEquals(result.sub, "no billing data yet");
  },
);

Deno.test(
  "cloud spend: a single exported day is one the export has not finished",
  async () => {
    // Nothing later has been written, so the export may still be adding to it.
    const { result } = await withFetch(
      bigQueryStub(dailyRows("2026-01-09", "2026-01-09", () => 20)),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
    );
    assertEquals(result.status, "unknown");
    assertEquals(result.value, "—");
    assertEquals(result.sub, "no billing data yet");
  },
);

Deno.test(
  "cloud spend: days the export is still adding to stay out of the rate",
  async () => {
    const { result } = await withFetch(
      bigQueryStub([
        ...dailyRows("2026-01-01", "2026-01-07", () => 20),
        // The export's newest write touched both of these days, so it has
        // finished neither, and each holds part of a day's cost so far.
        ["2026-01-08", "5", "0", String(exportedAt("2026-01-10"))],
        ["2026-01-09", "5", "0", String(exportedAt("2026-01-10"))],
      ]),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
    );

    // Seven finished days at $20 rate the month at $620. Rating the two
    // part-days as well would put it near $517.
    assertEquals(result.value, "~$620/mo");
    assertEquals(
      result.aside,
      '<span class="hmtd">$150 MTD</span>',
    );
    assertEquals(result.duration, 7 * DAY);
  },
);

Deno.test(
  "cloud spend: an export that has finished nothing for days is gray",
  async () => {
    const { result } = await withFetch(
      bigQueryStub(dailyRows("2026-01-01", "2026-01-03", () => 20)),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
    );
    assertEquals(result.status, "unknown");
    assertEquals(result.value, "—");
    assertEquals(result.sub, "billing export 8 days behind");
  },
);

Deno.test(
  "cloud spend: malformed history is gray and never becomes a figure",
  async () => {
    for (
      const rows of [
        [["2026-01-09", "not-a-number", "0", "1767000000"]],
        [["not-a-day", "10", "0", "1767000000"]],
        [["2026-99-99", "10", "0", "1767000000"]],
        [["2026-01-11", "10", "0", "1767000000"]],
        [["2026-01-09", null, "0", "1767000000"]],
        [["2026-01-09", "10", "not-a-number", "1767000000"]],
        [["2026-01-09", "10", null, "1767000000"]],
        [["2026-01-09", "10", "0", "not-a-number"]],
        [["2026-01-09", "10", "0", null]],
      ] as (string | null)[][][]
    ) {
      const { result } = await withFetch(
        bigQueryStub(rows),
        () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
      );
      assertEquals(result.status, "unknown");
      assertEquals(result.value, "—");
      assertEquals(
        result.sub,
        "unavailable — check credentials",
      );
    }
  },
);

Deno.test(
  "cloud spend: an unreachable source is gray",
  async () => {
    const denied = await withFetch(
      (url) => url === METADATA_TOKEN_URL ? json({ access_token: "token" }) : new Response("no", { status: 403 }),
      () =>
        gcpSpend.collect(
          ctx({
            GCP_BILLING_TABLE: TABLE,
            GCP_DAILY_BUDGET: "500",
          }),
        ),
    );
    assertEquals(denied.result.status, "unknown");
    assertEquals(denied.result.value, "—");
    assertEquals(
      denied.result.sub,
      "unavailable — check credentials",
    );

    const noToken = await withFetch(
      () => new Response("{}", { status: 500 }),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
    );
    assertEquals(noToken.result.status, "unknown");
    assertEquals(
      noToken.result.sub,
      "unavailable — check credentials",
    );
    assert(
      !(noToken.result.value ?? "").includes("$"),
      "a dead source never reports a figure",
    );
  },
);
