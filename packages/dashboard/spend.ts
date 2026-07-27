// Shared daily-spend projection and charting for the dashboard's spend tiles.
// A monthly estimate uses every settled day in the current month. Until that
// supplies two weeks, it fills the rate window from the end of the prior month.
import type { Status } from "./types.ts";
import { multiSparkline, SPARK_FADE } from "./lib.ts";

export const DAY_MS = 86_400_000;
export const MIN_SPEND_WINDOW_DAYS = 14;
export const SPEND_HISTORY_DAYS = 45;

export interface SpendSummary {
  mtd: number;
  projected: number;
  estimateDays: number;
}

export interface SpendSummaryOptions {
  lagDays: number;
  measuredMtd?: number;
  priorMonthDaily?: number[];
  availableSince?: string;
}

interface Projection {
  projected: number;
  days: number;
}

interface ChartSpend {
  byDay: Map<string, number>;
}

export interface SpendChartSource {
  spend: ChartSpend | null;
  color: string;
  label?: string;
}

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

function monthlyProjection(
  mtd: number,
  coveredThis: number,
  daysInMonth: number,
  lastMonthDaily: number[],
): Projection {
  const needFromLast = Math.max(
    0,
    MIN_SPEND_WINDOW_DAYS - coveredThis,
  );
  const tail = needFromLast > 0 ? lastMonthDaily.slice(-needFromLast) : [];
  const days = coveredThis + tail.length;
  if (days <= 0) return { projected: mtd, days: 0 };
  const windowSpend = mtd +
    tail.reduce((sum, daily) => sum + daily, 0);
  return {
    projected: (windowSpend / days) * daysInMonth,
    days,
  };
}

export function projectMonthly(
  mtd: number,
  coveredThis: number,
  daysInMonth: number,
  lastMonthDaily: number[],
): number {
  return monthlyProjection(
    mtd,
    coveredThis,
    daysInMonth,
    lastMonthDaily,
  ).projected;
}

function firstAvailableIndex(
  availableSince: string | undefined,
  year: number,
  month0: number,
  daysInMonth: number,
): number {
  if (!availableSince) return 0;
  const available = Date.parse(`${availableSince}T00:00:00Z`);
  const start = Date.UTC(year, month0, 1);
  const end = Date.UTC(year, month0 + 1, 1);
  if (!Number.isFinite(available) || available <= start) return 0;
  if (available >= end) return daysInMonth;
  return new Date(available).getUTCDate() - 1;
}

export function summarizeDailySpend(
  byDay: Map<string, number>,
  now: Date,
  options: SpendSummaryOptions,
): SpendSummary {
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  const thisMonth = calendarMonth(byDay, year, month0);
  const dailyMtd = thisMonth.reduce((sum, amount) => sum + amount, 0);
  const mtd = options.measuredMtd ?? dailyMtd;
  const settledThis = settled(
    thisMonth,
    dayOfMonth,
    options.lagDays,
  );
  const currentStart = firstAvailableIndex(
    options.availableSince,
    year,
    month0,
    thisMonth.length,
  );
  const coveredThis = Math.max(0, settledThis.length - currentStart);
  const previousMonth = month0 === 0 ? 11 : month0 - 1;
  const previousYear = month0 === 0 ? year - 1 : year;
  const previous = calendarMonth(byDay, previousYear, previousMonth);
  const settledPrevious = settled(
    previous,
    previous.length + dayOfMonth,
    options.lagDays,
  );
  const previousStart = firstAvailableIndex(
    options.availableSince,
    previousYear,
    previousMonth,
    previous.length,
  );
  const lastMonthDaily = options.priorMonthDaily ??
    settledPrevious.slice(
      Math.min(previousStart, settledPrevious.length),
    );
  const daysInMonth = new Date(
    Date.UTC(year, month0 + 1, 0),
  ).getUTCDate();
  const projection = monthlyProjection(
    mtd,
    coveredThis,
    daysInMonth,
    lastMonthDaily,
  );
  return {
    mtd,
    projected: projection.projected,
    estimateDays: projection.days,
  };
}

export function spendChart(
  sources: SpendChartSource[],
  now: Date,
  status: Status,
  estimateDays?: number,
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
  const start = Math.max(
    timeOf(sorted[0]),
    end - (SPEND_HISTORY_DAYS - 1) * DAY_MS,
  );
  const grid: string[] = [];
  for (let time = start; time <= end; time += DAY_MS) {
    grid.push(new Date(time).toISOString().slice(0, 10));
  }
  const lines = sources.flatMap((source) =>
    source.spend
      ? [{
        vals: grid.map((day) => source.spend!.byDay.get(day) ?? 0),
        color: source.color,
        label: source.label,
      }]
      : []
  );
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const currentDays = grid.filter((day) => day >= monthStart).length;
  const highlightDays = Math.min(
    grid.length,
    estimateDays ??
      Math.max(currentDays, MIN_SPEND_WINDOW_DAYS),
  );
  return {
    chart: multiSparkline(lines, {
      fadeFrom: SPARK_FADE[status],
      highlight: { count: highlightDays },
    }),
    duration: end - start + DAY_MS,
  };
}
