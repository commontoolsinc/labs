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

function dailyRows(
  first: string,
  last: string,
  amount: (day: string) => number,
): string[][] {
  const rows: string[][] = [];
  for (
    let time = Date.parse(`${first}T00:00:00Z`);
    time <= Date.parse(`${last}T00:00:00Z`);
    time += DAY
  ) {
    const day = new Date(time).toISOString().slice(0, 10);
    rows.push([day, String(amount(day))]);
  }
  return rows;
}

const earlyMonthRows = () =>
  dailyRows(
    "2025-11-26",
    "2026-01-09",
    (day) => day.startsWith("2026-01") ? 20 : 10,
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
      bigQueryStub([["2026-01-09", "10"]]),
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

    // Nine complete January days at $20 plus five December days at $10 form
    // the 14-day rate: $230 / 14 * 31 = about $509.
    assertEquals(result.status, "good");
    assertEquals(result.value, "~$509/mo");
    assertEquals(
      result.aside,
      '<span class="hmtd">$180 MTD</span>',
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
          ["2026-01-01", "7"],
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
      bigQueryStub([["2026-01-09", "20"]]),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
    );

    assertEquals(result.value, "~$620/mo");
    assertEquals(
      result.aside,
      '<span class="hmtd">$20 MTD</span>',
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
  "cloud spend: a missing last complete day means billing data has not arrived",
  async () => {
    const { result } = await withFetch(
      bigQueryStub([
        ["2026-01-08", "20"],
        ["2026-01-10", "5"],
      ]),
      () => gcpSpend.collect(ctx({ GCP_BILLING_TABLE: TABLE })),
    );
    assertEquals(result.status, "unknown");
    assertEquals(result.value, "—");
    assertEquals(result.sub, "no billing data yet");
  },
);

Deno.test(
  "cloud spend: malformed history is gray and never becomes a figure",
  async () => {
    for (
      const rows of [
        [["2026-01-09", "not-a-number"]],
        [["not-a-day", "10"]],
        [["2026-99-99", "10"]],
        [["2026-01-11", "10"]],
        [["2026-01-09", null]],
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
