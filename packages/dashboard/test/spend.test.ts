// spendChart: the shared multi-source daily-spend chart. Each source's line
// covers only the days that source is known for — reported days plus settled
// quiet days — so one source's freshness never pads another with zeros.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spendChart } from "../spend.ts";

const DAY = 86_400_000;

// `days` equal daily figures starting at `from`, as byDay entries.
const run = (
  from: string,
  days: number,
  amount: number,
): Array<[string, number]> => {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: days }, (_, index): [string, number] => [
    new Date(start + index * DAY).toISOString().slice(0, 10),
    amount,
  ]);
};

const source = (
  entries: Array<[string, number]>,
  lagDays: number,
  color: string,
) => ({
  spend: { byDay: new Map(entries) },
  color,
  lagDays,
});

// Every polyline in the chart, as [x, y] point lists in drawing order.
const polylines = (chart: string): number[][][] =>
  [...chart.matchAll(/<polyline points="([^"]+)"/g)].map((match) =>
    match[1].split(" ").map((pair) => pair.split(",").map(Number))
  );

const NOW = new Date("2026-01-20T09:00:00Z");

describe("spend", () => {
  it("ends a lagging source at its own known day instead of padding it with zeros", () => {
    const github = source(run("2026-01-01", 20, 1), 2, "#58a6ff");
    const blacksmith = source(run("2026-01-01", 19, 2), 1, "#f59e0b");
    const { chart, duration } = spendChart([github, blacksmith], NOW, "good");
    expect(duration).toBe(20 * DAY);
    const lines = polylines(chart);
    expect(lines.length).toBe(2);
    const [first, second] = lines;
    expect(first.length).toBe(20);
    expect(first[first.length - 1][0]).toBe(220);
    // The shorter line stops one day column short of the chart's right edge,
    // and holds its $2 height there instead of plunging to a padded zero.
    expect(second.length).toBe(19);
    expect(second[second.length - 1][0]).toBeCloseTo((18 / 19) * 220, 1);
    expect(new Set(second.map(([, y]) => y)).size).toBe(1);
  });

  it("charts a settled quiet stretch as zeros and stops at the settled horizon", () => {
    const github = source(run("2026-01-01", 10, 18), 2, "#58a6ff");
    const { chart, duration } = spendChart([github], NOW, "good");
    expect(duration).toBe(18 * DAY);
    const lines = polylines(chart);
    expect(lines.length).toBe(1);
    const heights = lines[0].map(([, y]) => y);
    // The 2-day lag settles the quiet 11th-18th into real charted zeros; the
    // unsettled 19th-20th are not drawn at all.
    expect(lines[0].length).toBe(18);
    expect(lines[0][17][0]).toBe(220);
    expect(new Set(heights.slice(10)).size).toBe(1);
    expect(heights[10]).toBeGreaterThan(heights[9]);
  });

  it("leaves a source alone whose newest day is already its settled horizon", () => {
    const gcp = source(run("2026-01-01", 19, 3), 1, "#4285f4");
    const { chart, duration } = spendChart([gcp], NOW, "good");
    expect(duration).toBe(19 * DAY);
    const lines = polylines(chart);
    expect(lines.length).toBe(1);
    expect(lines[0].length).toBe(19);
    expect(lines[0][18][0]).toBe(220);
  });

  it("aligns each line's highlight to the shared trailing window", () => {
    const github = source(run("2026-01-01", 20, 1), 2, "#58a6ff");
    const blacksmith = source(run("2026-01-01", 19, 2), 1, "#f59e0b");
    const { chart } = spendChart([github, blacksmith], NOW, "good", 5);
    const lines = polylines(chart);
    // Two bases, then the two bright trailing slices.
    expect(lines.length).toBe(4);
    const [, , firstTint, secondTint] = lines;
    // The window is the last five day columns; the shorter line has four of
    // them, and both slices start at the same column.
    expect(firstTint.length).toBe(5);
    expect(secondTint.length).toBe(4);
    expect(secondTint[0][0]).toBe(firstTint[0][0]);
  });
});
