// ci spend tests. The tile is a pure collect(ctx) -> TileView over GitHub and
// Blacksmith billing data. The tests pin the clock and provide fixed responses
// for both sources.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx, TileView } from "../types.ts";
import { REPO } from "../config.ts";
import { blacksmithRoutes } from "../blacksmith.ts";
import { githubCiSpend } from "./github-ci-spend.ts";

const ORG = "acme";
const D = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");

// One row of the enhanced billing platform's usage report. The report splits a
// product across SKUs and repos and carries a row only for a day with usage;
// netAmount is the billable dollars, already net of the included allowance.
const item = (date: string, netAmount: number, product = "actions") => ({
  date,
  product,
  sku: "Actions Linux 4 core",
  quantity: 1,
  unitType: "minutes",
  pricePerUnit: 0.008,
  grossAmount: netAmount,
  discountAmount: 0,
  netAmount,
  organizationName: ORG,
  repositoryName: "labs",
});

// A run of days in one month, each spending the same amount.
const days = (
  year: number,
  month: number,
  from: number,
  to: number,
  amount: number,
) =>
  Array.from(
    { length: to - from + 1 },
    (_, i) => item(`${year}-${pad(month)}-${pad(from + i)}`, amount),
  );

const usagePath = (year: number, month: number, org = ORG) =>
  `organizations/${org}/settings/billing/usage?year=${year}&month=${month}`;
const budgetsPath = (org = ORG) =>
  `organizations/${org}/settings/billing/budgets`;
const classicPath = (org = ORG) => `orgs/${org}/settings/billing/actions`;

const blacksmithDay = (date: string, cost: unknown) => ({
  date,
  jobs: 1,
  cost,
  minutes: 1,
});

function blacksmithRouteSet(
  now: string,
  dailyMetrics: unknown[],
  footprint: {
    dockerfile: unknown[];
    stickydisk: unknown[];
  } = { dockerfile: [], stickydisk: [] },
  storageByMonth: Record<string, number> = {},
  org = ORG,
  billing: { invoice?: unknown; threshold?: unknown } = {},
): Record<string, unknown> {
  const observed = new Date(now);
  const today = Date.UTC(
    observed.getUTCFullYear(),
    observed.getUTCMonth(),
    observed.getUTCDate(),
  );
  const end = new Date(today - 1);
  const start = new Date(today - 45 * D);
  const routes: Record<string, unknown> = {
    [`api/${blacksmithRoutes.daily(org, start, end)}`]: {
      daily_metrics: dailyMetrics,
    },
    [`api/${blacksmithRoutes.stickyDaily(org, start, end)}`]: footprint,
  };
  let cursor = new Date(start);
  while (cursor <= end) {
    const nextMonth = Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth() + 1,
      1,
    );
    const segmentEnd = new Date(Math.min(end.getTime(), nextMonth - 1));
    const month = cursor.toISOString().slice(0, 7);
    routes[`api/${blacksmithRoutes.stickyTotal(org, cursor, segmentEnd)}`] = {
      total_cost: storageByMonth[month] ?? 0,
      total_gb_hours: 0,
    };
    cursor = new Date(nextMonth);
  }
  const month = observed.toISOString().slice(0, 7);
  const measuredMtd = dailyMetrics.reduce<number>((sum, entry) => {
    if (!entry || typeof entry !== "object") return sum;
    const metric = entry as Record<string, unknown>;
    return typeof metric.date === "string" && metric.date.startsWith(month) &&
        Number.isFinite(Number(metric.cost))
      ? sum + Number(metric.cost)
      : sum;
  }, storageByMonth[month] ?? 0);
  routes[`api/${blacksmithRoutes.invoiceAmount(org)}`] = "invoice" in billing
    ? billing.invoice
    : measuredMtd;
  routes[`api/${blacksmithRoutes.spendingThreshold(org)}`] =
    "threshold" in billing ? billing.threshold : null;
  return routes;
}

const BLACKSMITH_ENV = {
  BLACKSMITH_API_TOKEN: "blacksmith-token",
  BLACKSMITH_ORG: ORG,
};

function ctx(env: Record<string, string>): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

// Run collect() with the clock fixed at `now` and GitHub answering from `routes`.
// A key is the api.github.com path with its query. A path the routes don't name
// answers 404 — what a month with no report, or an org with no budget, looks like.
// A route whose value is an Error rejects the fetch, as an unreachable API does.
async function view(
  now: string,
  routes: Record<string, unknown>,
  env: Record<string, string> = { GH_TOKEN: "gh_pat_x", GH_BILLING_ORG: ORG },
): Promise<TileView> {
  const RealDate = Date;
  const realFetch = globalThis.fetch;
  const fixed = RealDate.parse(now);
  globalThis.Date = class extends RealDate {
    constructor(...args: unknown[]) {
      // new Date() reads the pinned instant; new Date(x) keeps its argument.
      super(args.length === 0 ? fixed : (args[0] as number));
    }
  } as DateConstructor;
  globalThis.fetch = (input: URL | Request | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = url.pathname.slice(1) + url.search;
    if (!(key in routes)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const body = routes[key];
    if (body instanceof Error) return Promise.reject(body);
    if (body instanceof Response) return Promise.resolve(body);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    return await githubCiSpend.collect(ctx(env));
  } finally {
    globalThis.Date = RealDate;
    globalThis.fetch = realFetch;
  }
}

Deno.test("ci spend: without a token the tile is gray and names what it needs", async () => {
  const v = await githubCiSpend.collect(ctx({}));
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertStringIncludes(v.sub ?? "", "GH_TOKEN");
  assertStringIncludes(v.sub ?? "", "org billing read"); // the extra right this tile needs
  assertStringIncludes(v.sub ?? "", "BLACKSMITH_API_TOKEN");
});

Deno.test("ci spend: projects the month from the settled daily rate, against the GitHub budget", async () => {
  // The 20th of a 31-day month. Actions spend of $17/day on the 1st-10th, plus a
  // $10 row the report spells "Actions", is $180 month-to-date; the $500 of Copilot
  // is a different product and none of the tile's business.
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: {
      usageItems: [
        ...days(2026, 1, 1, 10, 17),
        item("2026-01-05", 10, "Actions"),
        item("2026-01-05", 500, "Copilot"),
      ],
    },
    [usagePath(2025, 12)]: { usageItems: days(2025, 12, 1, 31, 1) },
    [budgetsPath()]: {
      budgets: [
        { budget_product_sku: "copilot", budget_amount: 5 },
        { budget_product_sku: "actions", budget_amount: 2700 },
      ],
    },
  });
  // $180 over the 18 settled days of the month (the 20th, less the 2-day billing
  // lag), carried across all 31 -> $310. The quiet 11th-18th count; the unsettled
  // 19th-20th do not.
  assertEquals(v.value, "~$310/mo");
  assertEquals(v.aside, '<span class="hmtd">$180 MTD</span>');
  // The Actions budget, not the Copilot one that shares the response.
  assertEquals(v.sub, undefined);
  assertStringIncludes(v.extra ?? "", "Budget $2700");
  assertEquals(v.status, "good"); // $310 of a $2700 budget
  assertEquals(
    v.href,
    "https://github.com/organizations/acme/settings/billing",
  );
  assertEquals(v.hint, "billing ↗");
  assertStringIncludes(v.extra ?? "", "<polyline");
  // The line ends on the last day with a figure (the 10th), not on today: billing
  // runs a day or two behind, and drawing to today would show a fake dip to zero.
  // December 1st to January 10th inclusive is 41 days.
  assertEquals(v.duration, 41 * D);
});

Deno.test("ci spend: a 200 without a usageItems array grays out rather than reading as $0", async () => {
  // A permission-filtered view answers 200 with no usable report. Nothing was
  // measured, so nothing may be claimed — least of all a green "$0/mo".
  for (
    const body of [{}, { usageItems: null }, {
      usageItems: { message: "not visible" },
    }]
  ) {
    const v = await view("2026-01-20T09:00:00Z", {
      [usagePath(2026, 1)]: body,
    });
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "billing usage unavailable");
    assertEquals(
      v.href,
      "https://github.com/organizations/acme/settings/billing",
    ); // still drills through
  }
});

Deno.test("ci spend: no Actions budget in GitHub -> the projection stands, uncompared", async () => {
  const usage = { usageItems: days(2026, 1, 1, 10, 18) };
  // The org has no budgets endpoint response at all.
  const none = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: usage,
  });
  assertEquals(none.value, "~$310/mo");
  assertEquals(none.sub, undefined);
  assertStringIncludes(none.extra ?? "", "Budget $???");
  assertEquals(none.status, "good"); // an absent budget never alarms
  // The org budgets Actions' neighbours but not Actions.
  const other = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: usage,
    [budgetsPath()]: {
      budgets: [{ budget_product_sku: "copilot", budget_amount: 5 }],
    },
  });
  assertEquals(other.sub, undefined);
  assertStringIncludes(other.extra ?? "", "Budget $???");
  assertEquals(other.status, "good");
});

Deno.test("ci spend: a projection over budget goes amber, and well over goes red", async () => {
  const spend = (perDay: number) => ({
    usageItems: days(2026, 1, 1, 10, perDay),
  });
  const at = (perDay: number, budget: number) =>
    view("2026-01-20T09:00:00Z", {
      [usagePath(2026, 1)]: spend(perDay),
      [budgetsPath()]: {
        budgets: [{ budget_product_sku: "actions", budget_amount: budget }],
      },
    });
  // $18/day over the 10 days that spent -> $180 rated over 18 settled days -> $310.
  assertEquals((await at(18, 400)).status, "good"); // under budget
  assertEquals((await at(18, 300)).status, "warn"); // over, but within 25%
  assertEquals((await at(18, 100)).status, "bad"); // more than 25% over
});

Deno.test("ci spend: early in the month the rate comes from last month's tail", async () => {
  // The 3rd. Two days of this month is not a rate: $20/day here against $10/day
  // through December means the fortnight-long window has to reach back.
  const v = await view("2026-01-03T09:00:00Z", {
    [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 2, 20) },
    [usagePath(2025, 12)]: { usageItems: days(2025, 12, 1, 31, 10) },
    [usagePath(2025, 11)]: { usageItems: days(2025, 11, 1, 30, 10) },
  });
  // Window = $40 over 2 days here + $120 over the last 12 of December = $160/14
  // days -> $354 across 31. Rating the two days alone would claim $620.
  assertEquals(v.value, "~$354/mo");
  assertEquals(v.aside, '<span class="hmtd">$40 MTD</span>');
  // November is fetched only to fill the chart, which spans at most 45 days back
  // from the last day with a figure (January 2nd).
  assertEquals(v.duration, 45 * D);
});

Deno.test("ci spend: a prior month we can't read shortens the chart, it doesn't break the tile", async () => {
  // December 404s. This month has more than a fortnight of settled days, so the
  // projection never needed it; the chart just covers less.
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 10, 18) },
  });
  assertEquals(v.status, "good");
  assertEquals(v.value, "~$310/mo");
  assertEquals(v.duration, 10 * D); // January 1st to 10th only
});

Deno.test("ci spend: an unavailable prior month is not zero-spend history", async () => {
  const v = await view("2026-01-03T09:00:00Z", {
    [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 2, 20) },
    [budgetsPath()]: {
      budgets: [{ budget_product_sku: "actions", budget_amount: 400 }],
    },
  });
  assertEquals(v.value, "~$620/mo");
  assertEquals(v.aside, '<span class="hmtd">$40 MTD</span>');
  assertEquals(v.status, "bad");
  assertEquals(v.duration, 2 * D);
});

Deno.test("ci spend: one day of data is not a chart, but it is still a projection", async () => {
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: { usageItems: [item("2026-01-01", 180)] },
  });
  assertEquals(v.value, "~$310/mo");
  assertStringIncludes(v.extra ?? "", "GitHub $180");
  assertEquals(v.extra?.includes("<polyline"), false); // a single point draws no line
  assertEquals(v.duration, 0);
});

Deno.test("ci spend: a row whose date is unreadable leaves the chart out", async () => {
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: {
      usageItems: [item("2026-01-01", 180), item("", 20)],
    },
  });
  assertEquals(v.value, "~$344/mo");
  assertEquals(v.aside, '<span class="hmtd">$200 MTD</span>');
  assertStringIncludes(v.extra ?? "", "GitHub $200");
  assertEquals(v.extra?.includes("<polyline"), false);
  assertEquals(v.duration, 0);
});

Deno.test("ci spend: the classic plan falls back to minutes against the included allowance", async () => {
  // No enhanced billing platform: the usage report 404s and the old actions
  // endpoint answers in minutes.
  const classic = (used: number, included: number, paid: number) =>
    view("2026-01-20T09:00:00Z", {
      [classicPath()]: {
        total_minutes_used: used,
        included_minutes: included,
        total_paid_minutes_used: paid,
      },
    });
  const easy = await classic(1000, 3000, 0);
  assertEquals(easy.status, "good");
  assertEquals(easy.value, "0 paid min");
  assertEquals(easy.sub, "1000 / 3000 min · MTD");
  // Nearing the allowance is a warning; paying for minutes is the thing to act on.
  assertEquals((await classic(2500, 3000, 0)).status, "warn");
  const over = await classic(4000, 3000, 1000);
  assertEquals(over.status, "bad");
  assertEquals(over.value, "1000 paid min");
  // An org the endpoint reports no allowance for is not an org 100% through one.
  assertEquals((await classic(0, 0, 0)).status, "good");
});

Deno.test("ci spend: both billing endpoints unreachable -> gray with a calm reason", async () => {
  const v = await view("2026-01-20T09:00:00Z", {
    [classicPath()]: new TypeError(
      "error sending request for url (https://api.github.com/orgs/acme/…)",
    ),
  });
  assertEquals(v.status, "unknown"); // never a false green, never a red
  assertEquals(v.value, "—");
  assertEquals(v.sub, "source unreachable"); // the phrase, not the stack
  assertEquals(
    v.href,
    "https://github.com/organizations/acme/settings/billing",
  );
  assertStringIncludes(
    v.extra ?? "",
    '<span class="swatch" style="background:#58a6ff"></span> GitHub $??? • Budget $???',
  );
});

Deno.test("ci spend: every failed provider retains the combined middle line", async () => {
  const now = "2026-01-20T09:00:00Z";
  const routes = blacksmithRouteSet(now, []);
  const dailyPath = Object.keys(routes).find((path) =>
    path.includes("/metrics/daily?")
  )!;
  routes[dailyPath] = new Response(null, { status: 401 });

  const result = await view(now, routes, {
    GH_TOKEN: "gh_pat_x",
    GH_BILLING_ORG: ORG,
    ...BLACKSMITH_ENV,
    CI_MONTHLY_BUDGET: "500",
  });
  assertEquals(result.status, "unknown");
  assertEquals(result.value, "—");
  assertStringIncludes(
    result.extra ?? "",
    '<p class="sub"><span class="swatch" style="background:#58a6ff"></span> GitHub $??? • <span class="swatch" style="background:#f59e0b"></span> Blacksmith $??? • Budget $500</p>',
  );
});

Deno.test("ci spend: Blacksmith invoice, runner, storage, and threshold form one provider", async () => {
  const now = "2026-01-20T09:00:00Z";
  const compute = Array.from(
    { length: 10 },
    (_, index) => blacksmithDay(`2026-01-${pad(index + 1)}`, 10),
  );
  const routes = blacksmithRouteSet(
    now,
    compute,
    {
      dockerfile: [
        { date: "2026-01-01", value: 1 },
        { date: "2026-01-02", value: 3 },
      ],
      stickydisk: [],
    },
    { "2026-01": 40 },
    ORG,
    {
      invoice: { amount: 150, currency: "USD" },
      threshold: 230,
    },
  );
  const v = await view(now, routes, BLACKSMITH_ENV);

  assertEquals(v.value, "~$245/mo");
  assertEquals(v.aside, '<span class="hmtd">$150 MTD</span>');
  assertEquals(v.sub, undefined);
  assertEquals(v.status, "warn");
  assertEquals(v.href, "https://app.blacksmith.sh/");
  assertStringIncludes(v.extra ?? "", "Blacksmith");
  assertStringIncludes(v.extra ?? "", "$150");
  assertStringIncludes(v.extra ?? "", "Budget $230");
  assertStringIncludes(v.extra ?? "", "<polyline");
  assertEquals(v.duration, 10 * D);
});

Deno.test("ci spend: malformed Blacksmith costs never read as a green zero", async () => {
  const now = "2026-01-20T09:00:00Z";
  const malformedDaily = blacksmithRouteSet(now, [
    blacksmithDay("2026-01-01", null),
  ]);
  const negativeDaily = blacksmithRouteSet(now, [
    blacksmithDay("2026-01-01", -1),
  ]);
  const malformedTotal = blacksmithRouteSet(now, [
    blacksmithDay("2026-01-01", 1),
  ]);
  const totalPath = Object.keys(malformedTotal).find((path) =>
    path.includes("/sticky-disk/total?")
  )!;
  malformedTotal[totalPath] = { total_cost: null };
  const negativeTotal = blacksmithRouteSet(now, [
    blacksmithDay("2026-01-01", 1),
  ]);
  const negativeTotalPath = Object.keys(negativeTotal).find((path) =>
    path.includes("/sticky-disk/total?")
  )!;
  negativeTotal[negativeTotalPath] = { total_cost: -1 };

  for (
    const routes of [
      malformedDaily,
      negativeDaily,
      malformedTotal,
      negativeTotal,
    ]
  ) {
    const v = await view(now, routes, BLACKSMITH_ENV);
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
  }
});

Deno.test("ci spend: Blacksmith token errors say how to restore the source", async () => {
  const now = "2026-01-20T09:00:00Z";
  const expiredRoutes = blacksmithRouteSet(now, []);
  const dailyPath = Object.keys(expiredRoutes).find((path) =>
    path.includes("/metrics/daily?")
  )!;
  expiredRoutes[dailyPath] = new Response(null, { status: 401 });

  const rejected = await view(now, expiredRoutes, BLACKSMITH_ENV);
  assertEquals(rejected.status, "unknown");
  assertEquals(rejected.sub, "check BLACKSMITH_API_TOKEN");

  const invalid = await view(now, {}, {
    BLACKSMITH_API_TOKEN: "blacksmith-token",
    BLACKSMITH_API_URL: "not-a-url",
  });
  assertEquals(invalid.status, "unknown");
  assertEquals(invalid.sub, "check BLACKSMITH_API_URL");
});

Deno.test("ci spend: current Blacksmith billing endpoint failures are not hidden", async () => {
  const now = "2026-01-20T09:00:00Z";
  for (
    const route of [
      blacksmithRoutes.invoiceAmount(ORG),
      blacksmithRoutes.spendingThreshold(ORG),
    ]
  ) {
    const routes = blacksmithRouteSet(now, [
      blacksmithDay("2026-01-01", 10),
    ]);
    routes[`api/${route}`] = new Response(null, { status: 503 });

    const result = await view(now, routes, BLACKSMITH_ENV);
    assertEquals(result.status, "unknown");
    assertEquals(result.value, "—");
  }
});

Deno.test("ci spend: a combined budget avoids the unused Blacksmith threshold", async () => {
  const now = "2026-01-20T09:00:00Z";
  const routes = blacksmithRouteSet(now, [
    blacksmithDay("2026-01-01", 10),
  ]);
  routes[`api/${blacksmithRoutes.spendingThreshold(ORG)}`] = new Response(
    null,
    {
      status: 503,
    },
  );

  const result = await view(now, routes, {
    ...BLACKSMITH_ENV,
    CI_MONTHLY_BUDGET: "100",
  });
  assertEquals(result.status, "good");
  assertEquals(result.value, "~$16/mo");
  assertEquals(result.sub, undefined);
  assertStringIncludes(result.extra ?? "", "Budget $100");
});

Deno.test("ci spend: GitHub and Blacksmith share totals, chart, and combined budget", async () => {
  const now = "2026-01-20T09:00:00Z";
  const blacksmith = blacksmithRouteSet(
    now,
    Array.from(
      { length: 10 },
      (_, index) => blacksmithDay(`2026-01-${pad(index + 1)}`, 5),
    ),
  );
  const v = await view(
    now,
    {
      [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 10, 18) },
      [budgetsPath()]: {
        budgets: [
          { budget_product_sku: "actions", budget_amount: 1 },
        ],
      },
      ...blacksmith,
    },
    {
      GH_TOKEN: "gh_pat_x",
      GH_BILLING_ORG: ORG,
      ...BLACKSMITH_ENV,
      CI_MONTHLY_BUDGET: "350",
    },
  );

  assertEquals(v.value, "~$392/mo");
  assertEquals(v.aside, '<span class="hmtd">$230 MTD</span>');
  assertEquals(v.sub, undefined);
  assertEquals(v.status, "warn");
  assertEquals(v.href, undefined);
  assertStringIncludes(
    v.extra ?? "",
    '<p class="sub"><span class="swatch" style="background:#58a6ff"></span> GitHub • <span class="swatch" style="background:#f59e0b"></span> Blacksmith • Budget $350</p>',
  );
  assertStringIncludes(v.extra ?? "", "$180");
  assertStringIncludes(v.extra ?? "", "$50");
});

Deno.test("ci spend: provider budgets combine when no explicit budget is set", async () => {
  const now = "2026-01-20T09:00:00Z";
  const blacksmith = blacksmithRouteSet(
    now,
    Array.from(
      { length: 10 },
      (_, index) => blacksmithDay(`2026-01-${pad(index + 1)}`, 5),
    ),
    undefined,
    undefined,
    ORG,
    { threshold: 100 },
  );
  const v = await view(
    now,
    {
      [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 10, 18) },
      [budgetsPath()]: {
        budgets: [{ budget_product_sku: "actions", budget_amount: 300 }],
      },
      ...blacksmith,
    },
    {
      GH_TOKEN: "gh_pat_x",
      GH_BILLING_ORG: ORG,
      ...BLACKSMITH_ENV,
    },
  );

  assertEquals(v.value, "~$392/mo");
  assertEquals(v.sub, undefined);
  assertStringIncludes(v.extra ?? "", "Budget $400");
  assertEquals(v.status, "good");
});

Deno.test("ci spend: a partial provider budget is not treated as the combined budget", async () => {
  const now = "2026-01-20T09:00:00Z";
  const blacksmith = blacksmithRouteSet(
    now,
    [blacksmithDay("2026-01-01", 50)],
    undefined,
    undefined,
    ORG,
    { threshold: 1 },
  );
  const v = await view(
    now,
    {
      [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 10, 18) },
      ...blacksmith,
    },
    {
      GH_TOKEN: "gh_pat_x",
      GH_BILLING_ORG: ORG,
      ...BLACKSMITH_ENV,
    },
  );

  assertEquals(v.sub, undefined);
  assertStringIncludes(v.extra ?? "", "Budget $???");
  assertEquals(v.status, "good");
});

Deno.test("ci spend: one failed configured source leaves a gray lower bound", async () => {
  const now = "2026-01-20T09:00:00Z";
  const blacksmith = blacksmithRouteSet(now, []);
  const dailyPath = Object.keys(blacksmith).find((path) =>
    path.includes("/metrics/daily?")
  )!;
  blacksmith[dailyPath] = new Response(null, { status: 401 });
  const v = await view(
    now,
    {
      [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 10, 18) },
      ...blacksmith,
    },
    {
      GH_TOKEN: "gh_pat_x",
      GH_BILLING_ORG: ORG,
      ...BLACKSMITH_ENV,
      CI_MONTHLY_BUDGET: "1",
    },
  );

  assertEquals(v.value, "≥$310/mo");
  assertEquals(v.aside, '<span class="hmtd">$180 MTD</span>');
  assertEquals(v.status, "unknown");
  assertStringIncludes(
    v.extra ?? "",
    '<span class="swatch" style="background:#f59e0b"></span> Blacksmith $???',
  );
  assertStringIncludes(v.extra ?? "", "GitHub");
  assertStringIncludes(v.extra ?? "", "Budget $1");
});

Deno.test("ci spend: GITHUB_TOKEN works, and the org defaults to the CI tiles' repo owner", async () => {
  const org = REPO.split("/")[0];
  const v = await view(
    "2026-01-20T09:00:00Z",
    { [usagePath(2026, 1, org)]: { usageItems: days(2026, 1, 1, 10, 18) } },
    { GITHUB_TOKEN: "gh_pat_x" },
  );
  assertEquals(v.value, "~$310/mo");
  assertEquals(
    v.href,
    `https://github.com/organizations/${org}/settings/billing`,
  );
  assert(org.length > 0);
});
