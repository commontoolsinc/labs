/**
 * ci spend tests. The tile is a pure collect(ctx) -> TileView over GitHub
 * billing data. The tests pin the clock and provide fixed responses.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx, TileView } from "../types.ts";
import { REPO } from "../config.ts";
import { projectMonthly } from "../spend.ts";
import { themedChartSeries } from "../theme.ts";
import { githubCiSpend } from "./github-ci-spend.ts";

const ORG = "acme";
const D = 86_400_000;

const themedSwatch = (color: string) =>
  `<span class="swatch" style="background:${
    themedChartSeries(color).color
  }"></span>`;

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

// A row that says only that the report is still being written through `date`:
// usage the org's allowance covered, which bills nothing. Without one, a report
// whose rows stop days before today has stopped being written for all the tile
// can tell, and the tile reads no further than the rows reach.
const stillReporting = (date: string) => item(date, 0);

const usagePath = (year: number, month: number, org = ORG) =>
  `organizations/${org}/settings/billing/usage?year=${year}&month=${month}`;
const budgetsPath = (org = ORG) =>
  `organizations/${org}/settings/billing/budgets`;
const classicPath = (org = ORG) => `orgs/${org}/settings/billing/actions`;

class RejectedRoute {
  constructor(readonly reason: unknown) {}
}

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
    if (body instanceof RejectedRoute) return Promise.reject(body.reason);
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
});

Deno.test("ci spend: a projection with no observed rate window preserves the measured total", () => {
  assertEquals(projectMonthly(37, 0, 31, []), 37);
});

Deno.test("ci spend: projects the month from the settled daily rate, against the GitHub budget", async () => {
  // The 20th of a 31-day month. Actions spend of $17/day on the 1st-10th, plus a
  // $10 row the report spells "Actions", is $180 month-to-date; the $500 of Copilot
  // is a different product and none of the tile's business. The report is still
  // being written through the 18th, so the days after the 10th are days that
  // cost nothing.
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: {
      usageItems: [
        ...days(2026, 1, 1, 10, 17),
        item("2026-01-05", 10, "Actions"),
        item("2026-01-05", 500, "Copilot"),
        stillReporting("2026-01-18"),
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
  // The line runs to the newest settled day, the 18th: the quiet 11th-18th are
  // real zeros and chart as such, while the unsettled 19th-20th have no figure
  // yet and are left off rather than drawn as a dip to zero. The 45-day window
  // then reaches back to December 5th.
  assertEquals(v.duration, 45 * D);
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

Deno.test("ci spend: a report that stopped days ago is unreadable, not a run of $0 days", async () => {
  // The report's newest row anywhere is the 10th, ten days before the tile
  // reads it. Reading the 11th onwards as days that cost nothing would take a
  // report that has stopped for a fortnight of thrift.
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 10, 18) },
  });
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—"); // no total, rather than the $180 the stale rows add to
  assertEquals(v.sub, "GitHub billing report 10 days behind");
  assertStringIncludes(v.extra ?? "", `${themedSwatch("#58a6ff")} GitHub $???`);
  assertEquals(v.extra?.includes("<polyline"), false);
  assertEquals(
    v.href,
    "https://github.com/organizations/acme/settings/billing",
  );
});

Deno.test("ci spend: a quiet Actions week reads as $0 days while the report is written", async () => {
  // Actions stops on the 10th, but the org's Copilot seats bill through the
  // 18th. One pipeline writes both, so the report is current and the quiet
  // Actions days are days Actions cost nothing.
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: {
      usageItems: [
        ...days(2026, 1, 1, 10, 18),
        item("2026-01-18", 500, "Copilot"),
      ],
    },
  });
  assertEquals(v.status, "good");
  assertEquals(v.value, "~$310/mo"); // $180 over the 18 settled days, across 31
  assertEquals(v.aside, '<span class="hmtd">$180 MTD</span>');
  assertStringIncludes(v.extra ?? "", "<polyline");
});

Deno.test("ci spend: a report with no row at all is an org that bills nothing here", async () => {
  // An empty report dates nothing, so there is no day to chart and no gap to
  // read as silence. It says the org has no billable usage, and the tile says
  // the same.
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: { usageItems: [] },
  });
  assertEquals(v.status, "good");
  assertEquals(v.value, "~$0/mo");
  assertStringIncludes(v.extra ?? "", `${themedSwatch("#58a6ff")} GitHub $0`);
});

Deno.test("ci spend: no Actions budget in GitHub -> the projection stands, uncompared", async () => {
  const usage = {
    usageItems: [...days(2026, 1, 1, 10, 18), stillReporting("2026-01-18")],
  };
  // The org has no budgets endpoint response at all.
  const none = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: usage,
  });
  assertEquals(none.value, "~$310/mo");
  assertEquals(none.sub, undefined);
  assertEquals((none.extra ?? "").includes("Budget"), false);
  assertEquals(none.status, "good"); // an absent budget never alarms
  // The org budgets Actions' neighbors but not Actions.
  const other = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: usage,
    [budgetsPath()]: {
      budgets: [{ budget_product_sku: "copilot", budget_amount: 5 }],
    },
  });
  assertEquals(other.sub, undefined);
  assertEquals((other.extra ?? "").includes("Budget"), false);
  assertEquals(other.status, "good");
});

Deno.test("ci spend: a projection over budget goes amber, and well over goes red", async () => {
  const spend = (perDay: number) => ({
    usageItems: [
      ...days(2026, 1, 1, 10, perDay),
      stillReporting("2026-01-18"),
    ],
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
    [usagePath(2026, 1)]: {
      usageItems: [...days(2026, 1, 1, 10, 18), stillReporting("2026-01-18")],
    },
  });
  assertEquals(v.status, "good");
  assertEquals(v.value, "~$310/mo");
  assertEquals(v.duration, 18 * D); // January 1st to the settled 18th only
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

Deno.test("ci spend: a prior month that 404s leaves a hole in the chart, not zeros", async () => {
  // December's report is missing between two months that answered. The 45-day
  // window still reaches back to 20 November, and December is left undrawn.
  const v = await view("2026-01-05T09:00:00Z", {
    [usagePath(2026, 1)]: { usageItems: days(2026, 1, 1, 3, 20) },
    [usagePath(2025, 11)]: { usageItems: days(2025, 11, 20, 30, 10) },
  });
  assertEquals(v.value, "~$620/mo");
  assertEquals(v.duration, 45 * D);
  // November and January are drawn as two separate pieces of line, plus the
  // bright trailing slice.
  assertEquals((v.extra ?? "").match(/<polyline/g)?.length, 3);
});

Deno.test("ci spend: one day of data is not a chart, but it is still a projection", async () => {
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: {
      usageItems: [item("2026-01-01", 180), stillReporting("2026-01-18")],
    },
  });
  assertEquals(v.value, "~$310/mo");
  assertStringIncludes(v.extra ?? "", "GitHub $180");
  assertEquals(v.extra?.includes("<polyline"), false); // a single point draws no line
  assertEquals(v.duration, 0);
});

Deno.test("ci spend: a row whose date is unreadable leaves the chart out", async () => {
  const v = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: {
      usageItems: [
        item("2026-01-01", 180),
        item("", 20),
        stillReporting("2026-01-18"),
      ],
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
  assertEquals(
    v.extra,
    `<p class="sub">${themedSwatch("#58a6ff")} GitHub $???</p>`,
  );
});

Deno.test("ci spend: a source that rejects without an Error remains unavailable", async () => {
  const rejected = new RejectedRoute("billing stopped");
  const result = await view("2026-01-20T09:00:00Z", {
    [usagePath(2026, 1)]: rejected,
    [classicPath()]: rejected,
  });

  assertEquals(result.status, "unknown");
  assertEquals(result.value, "—");
  assertEquals(result.sub, "CI spend unavailable");
});

Deno.test("ci spend: GITHUB_TOKEN works, and the org defaults to the CI tiles' repo owner", async () => {
  const org = REPO.split("/")[0];
  const v = await view(
    "2026-01-20T09:00:00Z",
    {
      [usagePath(2026, 1, org)]: {
        usageItems: [...days(2026, 1, 1, 10, 18), stillReporting("2026-01-18")],
      },
    },
    { GITHUB_TOKEN: "gh_pat_x" },
  );
  assertEquals(v.value, "~$310/mo");
  assertEquals(
    v.href,
    `https://github.com/organizations/${org}/settings/billing`,
  );
  assert(org.length > 0);
});
