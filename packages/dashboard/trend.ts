import type { Status } from "./types.ts";

const DAY_MS = 86_400_000;
const MIN_TREND_DAYS = 7;
const UP_PCT = 0.05;
const RAPID_PCT = 0.20;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function distinctTrendDays(times: number[], values: number[]): number {
  const days = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) days.add(Math.floor(times[i] / DAY_MS));
  }
  return days.size;
}

// Overall trend as the fractional change of a robust fit across the displayed
// range (+0.2 means the fit ends 20% higher than it starts).
//
// Sub-daily samples become one median value per calendar day. The fit is the
// median of every pairwise log slope between those daily values, projected over
// the complete day span. `times` must be ascending.
export function trendPct(times: number[], values: number[]): number {
  const byDay = new Map<number, number[]>();
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0) continue;
    const day = Math.floor(times[i] / DAY_MS);
    const samples = byDay.get(day);
    if (samples) samples.push(values[i]);
    else byDay.set(day, [values[i]]);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length < MIN_TREND_DAYS) return 0;
  const daily = days.map((day) => median(byDay.get(day)!));
  const slopes: number[] = [];
  for (let i = 0; i < days.length; i++) {
    for (let j = i + 1; j < days.length; j++) {
      slopes.push(
        (Math.log(daily[j]) - Math.log(daily[i])) / (days[j] - days[i]),
      );
    }
  }
  return Math.expm1(
    median(slopes) * (days[days.length - 1] - days[0]),
  );
}

export function trendStatus(pct: number): Status {
  return pct <= UP_PCT ? "good" : pct <= RAPID_PCT ? "warn" : "bad";
}

// A percent for modest moves; a fold multiplier once it passes four times in
// either direction.
export function trendPctLabel(pct: number): string {
  const ratio = pct + 1;
  const fold = (value: number) =>
    value >= 10 ? value.toFixed(0) : value.toFixed(1);
  if (ratio >= 4) return `▲${fold(ratio)}×`;
  if (ratio > 0 && 1 / ratio >= 4) return `▼${fold(1 / ratio)}×`;
  const percent = Math.round(pct * 100);
  return percent > 0 ? `▲${percent}%` : percent < 0 ? `▼${-percent}%` : "flat";
}
