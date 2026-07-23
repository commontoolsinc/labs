// ci spend: month-to-date CI cost across GitHub Actions and Blacksmith,
// projected to a full-month total. Each configured source contributes one line
// to a shared 45-day daily-spend chart. The line labels show each source's
// month-to-date spend and the header shows the combined month-to-date total.
//
// GitHub's enhanced billing report supplies daily net Actions spend. Blacksmith
// supplies an invoice total, daily runner cost, and a range total for sticky-disk
// storage. The invoice is the month-to-date source of truth. The daily endpoints
// supply the projection and chart, with storage assigned to days in proportion
// to the daily cache footprint. A configured source that cannot be read shows
// "$???" and makes the combined projection a lower bound.
import type { Status, Tile, TileView } from "../types.ts";
import {
  budgetStatus,
  friendlyError,
  github,
  multiSparkline,
  readBudget,
  SPARK_FADE,
  usd,
} from "../lib.ts";
import { REPO } from "../config.ts";
import { BlacksmithClient, blacksmithRoutes } from "../blacksmith.ts";

interface UsageItem {
  date: string;
  product: string;
  netAmount: number;
}

interface Budget {
  budget_product_sku?: string;
  budget_amount?: number;
}

interface ActionsBilling {
  total_minutes_used: number;
  total_paid_minutes_used: number;
  included_minutes: number;
}

interface DailySpend {
  byDay: Map<string, number>;
  mtd: number;
  projected: number;
}

interface GitHubDollarSpend extends DailySpend {
  kind: "dollars";
  budget: number;
}

interface BlacksmithSpend extends DailySpend {
  budget: number;
}

interface GitHubMinuteSpend {
  kind: "minutes";
  used: number;
  included: number;
  paid: number;
}

type GitHubSpend = GitHubDollarSpend | GitHubMinuteSpend;

interface BlacksmithDailyResponse {
  daily_metrics?: Array<{
    date?: unknown;
    cost?: unknown;
  }>;
}

interface BlacksmithStickyDailyResponse {
  dockerfile?: Array<{ date?: unknown; value?: unknown }>;
  stickydisk?: Array<{ date?: unknown; value?: unknown }>;
}

interface BlacksmithStickyTotalResponse {
  total_cost?: unknown;
}

const actionsOf = (report: { usageItems?: UsageItem[] }): UsageItem[] =>
  (report.usageItems ?? []).filter((item) =>
    String(item.product).toLowerCase() === "actions"
  );

const usagePath = (org: string, year: number, month: number) =>
  `organizations/${org}/settings/billing/usage?year=${year}&month=${month}`;

export const GITHUB_LAG_DAYS = 2;
export const PROVIDER_LAG_DAYS = 1;
export const MIN_WINDOW_DAYS = 14;
const SPARK_DAYS = 45;
const DAY_MS = 86_400_000;
const GITHUB_COLOR = "#58a6ff";
const BLACKSMITH_COLOR = "#f59e0b";

export function settled(
  daily: number[],
  elapsedDays: number,
  lagDays: number,
): number[] {
  let withData = daily.length;
  while (withData > 0 && daily[withData - 1] === 0) withData--;
  const known = Math.max(withData, elapsedDays - lagDays);
  return daily.slice(0, Math.max(0, Math.min(daily.length, known)));
}

export function calendarMonth(
  byDay: Map<string, number>,
  year: number,
  month0: number,
): number[] {
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const prefix = `${year}-${String(month0 + 1).padStart(2, "0")}-`;
  return Array.from(
    { length: days },
    (_, index) => byDay.get(prefix + String(index + 1).padStart(2, "0")) ?? 0,
  );
}

export function projectMonthly(
  mtd: number,
  coveredThis: number,
  daysInMonth: number,
  lastMonthDaily: number[],
): number {
  const needFromLast = Math.max(0, MIN_WINDOW_DAYS - coveredThis);
  const tail = needFromLast > 0 ? lastMonthDaily.slice(-needFromLast) : [];
  const windowDays = coveredThis + tail.length;
  if (windowDays <= 0) return mtd;
  const windowSpend = mtd + tail.reduce((sum, daily) => sum + daily, 0);
  return (windowSpend / windowDays) * daysInMonth;
}

function dayKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === day ? day : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addDaily(
  target: Map<string, number>,
  day: string,
  amount: number,
): void {
  if (amount === 0) return;
  target.set(day, (target.get(day) ?? 0) + amount);
}

function addGitHubDays(
  target: Map<string, number>,
  items: UsageItem[],
): void {
  for (const item of items) {
    const day = dayKey(item.date);
    if (!day) continue;
    addDaily(target, day, Number(item.netAmount) || 0);
  }
}

function summarizeDaily(
  byDay: Map<string, number>,
  now: Date,
  lagDays: number,
  measuredMtd?: number,
  priorMonthDaily?: number[],
): Omit<DailySpend, "byDay"> {
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  const thisMonth = calendarMonth(byDay, year, month0);
  const dailyMtd = thisMonth.reduce((sum, amount) => sum + amount, 0);
  const mtd = measuredMtd ?? dailyMtd;
  const coveredThis = settled(thisMonth, dayOfMonth, lagDays).length;
  const previousMonth = month0 === 0 ? 11 : month0 - 1;
  const previousYear = month0 === 0 ? year - 1 : year;
  const previous = calendarMonth(byDay, previousYear, previousMonth);
  const lastMonthDaily = priorMonthDaily ??
    settled(
      previous,
      previous.length + dayOfMonth,
      lagDays,
    );
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return {
    mtd,
    projected: projectMonthly(
      mtd,
      coveredThis,
      daysInMonth,
      lastMonthDaily,
    ),
  };
}

class GitHubUsageShapeError extends Error {}

async function githubDollarSpend(
  token: string,
  org: string,
  now: Date,
): Promise<GitHubDollarSpend> {
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  const report = await github<{ usageItems?: UsageItem[] }>(
    usagePath(org, year, month0 + 1),
    token,
  );
  if (!Array.isArray(report.usageItems)) {
    throw new GitHubUsageShapeError("billing usage unavailable");
  }

  const current = actionsOf(report);
  const mtd = current.reduce(
    (sum, item) => sum + (Number(item.netAmount) || 0),
    0,
  );
  const byDay = new Map<string, number>();
  addGitHubDays(byDay, current);
  let priorMonthDaily: number[] = [];
  let immediatePrior = true;
  let remaining = SPARK_DAYS - dayOfMonth;
  let previousYear = year;
  let previousMonth = month0;
  while (remaining > 0) {
    previousMonth--;
    if (previousMonth < 0) {
      previousMonth = 11;
      previousYear--;
    }
    try {
      const previous = await github<{ usageItems?: UsageItem[] }>(
        usagePath(org, previousYear, previousMonth + 1),
        token,
      );
      if (Array.isArray(previous.usageItems)) {
        const previousItems = actionsOf(previous);
        addGitHubDays(byDay, previousItems);
        if (immediatePrior) {
          const previousSeries = calendarMonth(
            byDay,
            previousYear,
            previousMonth,
          );
          priorMonthDaily = settled(
            previousSeries,
            previousSeries.length + dayOfMonth,
            GITHUB_LAG_DAYS,
          );
        }
      }
    } catch {
      // A missing prior month shortens the chart and leaves current billing usable.
    }
    remaining -= new Date(
      Date.UTC(previousYear, previousMonth + 1, 0),
    ).getUTCDate();
    immediatePrior = false;
  }

  let budget = NaN;
  try {
    const response = await github<{ budgets?: Budget[] }>(
      `organizations/${org}/settings/billing/budgets`,
      token,
    );
    const actions = (response.budgets ?? []).find((entry) =>
      String(entry.budget_product_sku).toLowerCase() === "actions"
    );
    if (actions && Number.isFinite(Number(actions.budget_amount))) {
      budget = Number(actions.budget_amount);
    }
  } catch {
    // An unset GitHub budget leaves the spend projection uncompared.
  }

  return {
    kind: "dollars",
    byDay,
    ...summarizeDaily(
      byDay,
      now,
      GITHUB_LAG_DAYS,
      mtd,
      priorMonthDaily,
    ),
    budget,
  };
}

async function githubSpend(
  token: string,
  org: string,
  now: Date,
): Promise<GitHubSpend> {
  try {
    return await githubDollarSpend(token, org, now);
  } catch (error) {
    if (error instanceof GitHubUsageShapeError) throw error;
    const billing = await github<ActionsBilling>(
      `orgs/${org}/settings/billing/actions`,
      token,
    );
    return {
      kind: "minutes",
      used: Number(billing.total_minutes_used) || 0,
      included: Number(billing.included_minutes) || 0,
      paid: Number(billing.total_paid_minutes_used) || 0,
    };
  }
}

function parseBlacksmithDaily(
  response: BlacksmithDailyResponse,
): Map<string, number> {
  if (!Array.isArray(response.daily_metrics)) {
    throw new Error("Blacksmith daily costs have an unexpected shape");
  }
  const byDay = new Map<string, number>();
  for (const entry of response.daily_metrics) {
    const day = dayKey(entry.date);
    const cost = finiteNumber(entry.cost);
    if (!day || cost === null || cost < 0) {
      throw new Error("Blacksmith daily costs have an unexpected shape");
    }
    addDaily(byDay, day, cost);
  }
  return byDay;
}

function parseBlacksmithFootprint(
  response: BlacksmithStickyDailyResponse,
): Map<string, number> {
  if (
    !Array.isArray(response.dockerfile) || !Array.isArray(response.stickydisk)
  ) {
    throw new Error("Blacksmith storage usage has an unexpected shape");
  }
  const byDay = new Map<string, number>();
  for (const entries of [response.dockerfile, response.stickydisk]) {
    for (const entry of entries) {
      const day = dayKey(entry.date);
      const bytes = finiteNumber(entry.value);
      if (!day || bytes === null || bytes < 0) {
        throw new Error("Blacksmith storage usage has an unexpected shape");
      }
      addDaily(byDay, day, bytes);
    }
  }
  return byDay;
}

function parseBlacksmithInvoice(response: unknown): number {
  let amount: unknown = response;
  if (response && typeof response === "object") {
    const invoice = response as Record<string, unknown>;
    if (
      "currency" in invoice &&
      (typeof invoice.currency !== "string" ||
        invoice.currency.toUpperCase() !== "USD")
    ) {
      throw new Error("Blacksmith invoice amount has an unexpected shape");
    }
    amount = invoice.amount;
  }
  const parsed = finiteNumber(amount);
  if (parsed === null || parsed < 0) {
    throw new Error("Blacksmith invoice amount has an unexpected shape");
  }
  return parsed;
}

function parseBlacksmithBudget(response: unknown): number {
  if (response === null || response === undefined) return NaN;
  let threshold: unknown = response;
  if (typeof response === "object") {
    const settings = response as Record<string, unknown>;
    if (!("threshold" in settings) && !("email_alert_threshold" in settings)) {
      throw new Error("Blacksmith spending threshold has an unexpected shape");
    }
    threshold = settings.threshold ?? settings.email_alert_threshold;
  }
  if (threshold === null || threshold === undefined) return NaN;
  const parsed = finiteNumber(threshold);
  if (parsed === null || parsed < 0) {
    throw new Error("Blacksmith spending threshold has an unexpected shape");
  }
  return parsed;
}

function calendarDays(start: Date, end: Date): string[] {
  const days: string[] = [];
  const first = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const last = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );
  for (let time = first; time <= last; time += DAY_MS) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

function monthSegments(start: Date, end: Date): Array<{
  start: Date;
  end: Date;
}> {
  const segments: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const nextMonth = Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth() + 1,
      1,
    );
    const segmentEnd = new Date(Math.min(end.getTime(), nextMonth - 1));
    segments.push({ start: new Date(cursor), end: segmentEnd });
    cursor = new Date(nextMonth);
  }
  return segments;
}

function addAllocatedStorage(
  target: Map<string, number>,
  footprint: Map<string, number>,
  start: Date,
  end: Date,
  totalCost: number,
): void {
  const days = calendarDays(start, end);
  if (days.length === 0 || totalCost === 0) return;
  const totalWeight = days.reduce(
    (sum, day) => sum + (footprint.get(day) ?? 0),
    0,
  );
  for (const day of days) {
    const share = totalWeight > 0
      ? (footprint.get(day) ?? 0) / totalWeight
      : 1 / days.length;
    addDaily(target, day, totalCost * share);
  }
}

async function blacksmithSpend(
  client: BlacksmithClient,
  org: string,
  now: Date,
  readProviderBudget: boolean,
): Promise<BlacksmithSpend> {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const end = new Date(today - 1);
  const start = new Date(today - SPARK_DAYS * DAY_MS);
  const segments = monthSegments(start, end);
  const [daily, stickyDaily, stickyTotals, invoice, threshold] = await Promise
    .all([
      client.get<BlacksmithDailyResponse>(
        blacksmithRoutes.daily(org, start, end),
      ),
      client.get<BlacksmithStickyDailyResponse>(
        blacksmithRoutes.stickyDaily(org, start, end),
      ),
      Promise.all(
        segments.map((segment) =>
          client.get<BlacksmithStickyTotalResponse>(
            blacksmithRoutes.stickyTotal(org, segment.start, segment.end),
          )
        ),
      ),
      client.get<unknown>(blacksmithRoutes.invoiceAmount(org)),
      readProviderBudget
        ? client.get<unknown>(blacksmithRoutes.spendingThreshold(org))
        : Promise.resolve(undefined),
    ]);
  const compute = parseBlacksmithDaily(daily);
  const footprint = parseBlacksmithFootprint(stickyDaily);
  for (const [index, response] of stickyTotals.entries()) {
    const totalCost = finiteNumber(response.total_cost);
    if (totalCost === null || totalCost < 0) {
      throw new Error("Blacksmith storage cost has an unexpected shape");
    }
    const segment = segments[index];
    addAllocatedStorage(
      compute,
      footprint,
      segment.start,
      segment.end,
      totalCost,
    );
  }
  const measuredMtd = parseBlacksmithInvoice(invoice);
  return {
    byDay: compute,
    ...summarizeDaily(
      compute,
      now,
      PROVIDER_LAG_DAYS,
      measuredMtd,
    ),
    budget: parseBlacksmithBudget(threshold),
  };
}

function spendChart(
  sources: Array<{
    spend: DailySpend | null;
    color: string;
  }>,
  now: Date,
  status: Status,
): { chart: string; duration: number } {
  const allDays = new Set<string>();
  for (const source of sources) {
    if (source.spend) {
      for (const day of source.spend.byDay.keys()) allDays.add(day);
    }
  }
  if (allDays.size < 2) return { chart: "", duration: 0 };
  const sorted = [...allDays].sort();
  const timeOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
  const end = timeOf(sorted[sorted.length - 1]);
  const start = Math.max(timeOf(sorted[0]), end - (SPARK_DAYS - 1) * DAY_MS);
  const grid: string[] = [];
  for (let time = start; time <= end; time += DAY_MS) {
    grid.push(new Date(time).toISOString().slice(0, 10));
  }
  const lines = sources.flatMap((source) =>
    source.spend
      ? [{
        vals: grid.map((day) => source.spend!.byDay.get(day) ?? 0),
        color: source.color,
        label: usd(source.spend.mtd),
      }]
      : []
  );
  const monthStart = `${now.getUTCFullYear()}-${
    String(now.getUTCMonth() + 1).padStart(2, "0")
  }-01`;
  const currentDays = grid.filter((day) => day >= monthStart).length;
  const windowDays = Math.min(
    grid.length,
    Math.max(currentDays, MIN_WINDOW_DAYS),
  );
  return {
    chart: multiSparkline(lines, {
      fadeFrom: SPARK_FADE[status],
      highlight: { count: windowDays },
    }),
    duration: end - start + DAY_MS,
  };
}

function minutesView(
  org: string,
  spend: GitHubMinuteSpend,
): TileView {
  const fraction = spend.included > 0 ? spend.used / spend.included : 0;
  const status: Status = spend.paid > 0 || fraction >= 1
    ? "bad"
    : fraction >= 0.8
    ? "warn"
    : "good";
  return {
    label: "ci spend",
    status,
    value: `${spend.paid} paid min`,
    sub: `${spend.used} / ${spend.included} min · MTD`,
    href: `https://github.com/organizations/${org}/settings/billing`,
    hint: "billing ↗",
  };
}

function unavailableMessage(error: unknown): string {
  if (error instanceof GitHubUsageShapeError) return error.message;
  if (!(error instanceof Error)) return "CI spend unavailable";
  if (error.message === "Blacksmith API token rejected") {
    return "check BLACKSMITH_API_TOKEN";
  }
  if (error.message.includes("BLACKSMITH_API_URL")) {
    return "check BLACKSMITH_API_URL";
  }
  return friendlyError(error.message);
}

export const githubCiSpend: Tile = {
  id: "github-ci-spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const label = "ci spend";
    const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
    const blacksmithToken = ctx.env("BLACKSMITH_API_TOKEN")?.trim();
    if (!token && !blacksmithToken) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "set GH_TOKEN (needs org billing read) / BLACKSMITH_API_TOKEN",
      };
    }

    const githubOrg = ctx.env("GH_BILLING_ORG") ?? REPO.split("/")[0];
    const combinedBudgetRaw = ctx.env("CI_MONTHLY_BUDGET");
    const hasCombinedBudget = combinedBudgetRaw !== undefined &&
      combinedBudgetRaw.trim() !== "";
    const now = new Date();
    const [githubResult, blacksmithResult] = await Promise.all([
      token
        ? githubSpend(token, githubOrg, now).catch((error) => ({ error }))
        : Promise.resolve(null),
      blacksmithToken
        ? (async () => {
          const client = BlacksmithClient.fromEnvironment(ctx.env);
          if (!client) throw new Error("Blacksmith API token unavailable");
          const org = ctx.env("BLACKSMITH_ORG") ??
            ctx.env("GH_BILLING_ORG") ?? REPO.split("/")[0];
          return await blacksmithSpend(client, org, now, !hasCombinedBudget);
        })().catch((error) => ({ error }))
        : Promise.resolve(null),
    ]);

    const githubError = githubResult && "error" in githubResult
      ? githubResult.error
      : null;
    const blacksmithError = blacksmithResult && "error" in blacksmithResult
      ? blacksmithResult.error
      : null;
    const githubValue = githubResult && !("error" in githubResult)
      ? githubResult
      : null;
    const blacksmithValue = blacksmithResult && !("error" in blacksmithResult)
      ? blacksmithResult
      : null;

    if (
      githubValue?.kind === "minutes" && !blacksmithToken &&
      !blacksmithError
    ) {
      return minutesView(githubOrg, githubValue);
    }

    const githubDollars = githubValue?.kind === "dollars" ? githubValue : null;
    const present = [githubDollars, blacksmithValue].filter(
      (spend): spend is GitHubDollarSpend | BlacksmithSpend => spend !== null,
    );
    const combinedBudget = readBudget(combinedBudgetRaw);
    const githubBudget = githubDollars?.budget ?? NaN;
    const blacksmithBudget = blacksmithValue?.budget ?? NaN;
    const providerBudget = token && blacksmithToken
      ? Number.isFinite(githubBudget) && Number.isFinite(blacksmithBudget)
        ? githubBudget + blacksmithBudget
        : NaN
      : token
      ? githubBudget
      : blacksmithBudget;
    const budget = hasCombinedBudget ? combinedBudget : providerBudget;
    const swatch = (color: string) =>
      `<span class="swatch" style="background:${color}"></span>`;
    const legendItem = (
      configured: boolean,
      spend: DailySpend | null,
      name: string,
      color: string,
      charted: boolean,
    ): string[] => {
      if (!configured) return [];
      if (!spend) return [`${swatch(color)} ${name} $???`];
      const amount = charted ? "" : ` ${usd(spend.mtd)}`;
      return [`${swatch(color)} ${name}${amount}`];
    };
    const legend = (charted: boolean): string =>
      `<p class="sub">${
        [
          ...legendItem(
            Boolean(token),
            githubDollars,
            "GitHub",
            GITHUB_COLOR,
            charted,
          ),
          ...legendItem(
            Boolean(blacksmithToken),
            blacksmithValue,
            "Blacksmith",
            BLACKSMITH_COLOR,
            charted,
          ),
          `Budget ${Number.isFinite(budget) ? usd(budget) : "$???"}`,
        ].join(" • ")
      }</p>`;
    if (present.length === 0) {
      const error = githubError ?? blacksmithError;
      return {
        ...(token && !blacksmithToken
          ? {
            href:
              `https://github.com/organizations/${githubOrg}/settings/billing`,
            hint: "billing ↗",
          }
          : {}),
        label,
        status: "unknown",
        value: "—",
        sub: unavailableMessage(error),
        extra: legend(false),
      };
    }

    const complete = !(
      (token && !githubDollars) ||
      (blacksmithToken && !blacksmithValue)
    );
    const totalMtd = present.reduce((sum, spend) => sum + spend.mtd, 0);
    const totalProjected = present.reduce(
      (sum, spend) => sum + spend.projected,
      0,
    );
    const status: Status = complete
      ? budgetStatus(totalProjected, budget)
      : "unknown";
    const chart = spendChart(
      [
        { spend: githubDollars, color: GITHUB_COLOR },
        { spend: blacksmithValue, color: BLACKSMITH_COLOR },
      ],
      now,
      status,
    );

    const drill = token && !blacksmithToken
      ? {
        href: `https://github.com/organizations/${githubOrg}/settings/billing`,
        hint: "billing ↗",
      }
      : !token && blacksmithToken
      ? { href: "https://app.blacksmith.sh/", hint: "billing ↗" }
      : {};

    return {
      ...drill,
      label,
      status,
      value: `${complete ? "~" : "≥"}${usd(totalProjected)}/mo`,
      aside: `<span class="hmtd">${usd(totalMtd)} MTD</span>`,
      extra: `${legend(Boolean(chart.chart))}${chart.chart}`,
      duration: chart.duration,
    };
  },
};
