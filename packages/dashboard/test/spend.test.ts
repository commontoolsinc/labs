// spendChart: the shared multi-source daily-spend chart. Each source's line
// covers only the days that source is known for — reported days plus settled
// quiet days — so one source's freshness never pads another with zeros. Plus
// the two readings a tile takes of a source's reports to decide whether the
// quiet days are quiet at all.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { newestReportedDay, reportLagDays, spendChart } from "../spend.ts";

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
  knownMonths?: string[],
) => ({
  spend: { byDay: new Map(entries) },
  color,
  lagDays,
  ...(knownMonths ? { knownMonths: new Set(knownMonths) } : {}),
});

// Every polyline in the chart, as [x, y] point lists in drawing order.
const polylines = (chart: string): number[][][] =>
  [...chart.matchAll(/<polyline points="([^"]+)"/g)].map((match) =>
    match[1].split(" ").map((pair) => pair.split(",").map(Number))
  );

// Every explicit point marker in the chart, as [x, y] in drawing order. A
// point no polyline can reach is drawn as one of these instead.
const markers = (chart: string): number[][] =>
  [...chart.matchAll(/<circle cx="([^"]+)" cy="([^"]+)"/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);

const NOW = new Date("2026-01-20T09:00:00Z");

describe("spend", () => {
  it("takes the newest day a source has a figure for, whatever order they arrive in", () => {
    const byDay = new Map([
      ["2026-01-03", 1],
      ["2026-01-11", 0],
      ["2026-01-07", 2],
    ]);
    // A day that cost nothing is a day the source reported on all the same.
    expect(newestReportedDay(byDay)).toBe("2026-01-11");
    expect(newestReportedDay(new Map())).toBe(undefined);
  });

  it("measures a source's lag in whole days, from the day it reported through", () => {
    // The clock reads 09:00 on the 20th, and the lag counts calendar days, so
    // the time of day never moves it.
    expect(reportLagDays("2026-01-20", NOW)).toBe(0);
    expect(reportLagDays("2026-01-18", NOW)).toBe(2);
    expect(reportLagDays("2025-12-31", NOW)).toBe(20);
  });

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

  // A 45-day window opened on 5 January reaches back to 20 November, so a
  // December nobody could read sits between two months that were read. The
  // grid is 45 columns 5px apart: 20-30 November at columns 0-10, December at
  // columns 11-41, and 1-3 January at columns 42-44.
  const GAP_NOW = new Date("2026-01-05T09:00:00Z");
  const NOVEMBER = run("2025-11-20", 11, 1);
  const JANUARY = run("2026-01-01", 3, 2);

  it("breaks a line across a month its source has no report for", () => {
    const github = source(
      [...NOVEMBER, ...JANUARY],
      2,
      "#58a6ff",
      ["2025-11", "2026-01"],
    );
    const { chart, duration } = spendChart([github], GAP_NOW, "good");
    expect(duration).toBe(45 * DAY);
    const lines = polylines(chart);
    // Two pieces of base line, then the bright trailing slice.
    expect(lines.length).toBe(3);
    const [november, january] = lines;
    expect(november.length).toBe(11);
    expect(november[november.length - 1][0]).toBe(50);
    expect(january.length).toBe(3);
    expect(january[0][0]).toBe(210);
    expect(january[2][0]).toBe(220);
    // Nothing is drawn over December at all.
    const drawn = lines.flat().map(([x]) => x);
    expect(drawn.filter((x) => x > 50 && x < 210)).toEqual([]);
  });

  it("charts a month that was read but had no spend as real zeros", () => {
    const github = source(
      [...NOVEMBER, ...JANUARY],
      2,
      "#58a6ff",
      ["2025-11", "2025-12", "2026-01"],
    );
    const { chart } = spendChart([github], GAP_NOW, "good");
    const lines = polylines(chart);
    // One unbroken base line, then the bright trailing slice.
    expect(lines.length).toBe(2);
    expect(lines[0].length).toBe(45);
    const december = lines[0].slice(11, 42).map(([, y]) => y);
    expect(new Set(december).size).toBe(1);
    expect(december[0]).toBeGreaterThan(lines[0][10][1]);
  });

  it("holds a highlight to the days its source reports on", () => {
    const github = source(
      [...NOVEMBER, ...JANUARY],
      2,
      "#58a6ff",
      ["2025-11", "2026-01"],
    );
    const blacksmith = source(run("2025-11-20", 45, 2), 2, "#f59e0b");
    const { chart } = spendChart([github, blacksmith], GAP_NOW, "good", 20);
    const lines = polylines(chart);
    // Two pieces of the holed base line, one whole base line, then a slice of
    // each.
    expect(lines.length).toBe(5);
    const [, , , githubTint, blacksmithTint] = lines;
    // The window opens at column 25, inside the hole. The unbroken line's
    // slice starts there; the holed one picks up at its first reported day.
    expect(blacksmithTint.length).toBe(20);
    expect(blacksmithTint[0][0]).toBe(125);
    expect(githubTint.length).toBe(3);
    expect(githubTint[0][0]).toBe(210);
    expect(githubTint[2][0]).toBe(blacksmithTint[19][0]);
  });

  it("stops at the last day it reports on rather than at the settled horizon", () => {
    // December was read and January was not, so on 5 January a 2-day lag
    // settles no January day. The line ends on 31 December.
    const github = source(run("2025-12-01", 20, 5), 2, "#58a6ff", ["2025-12"]);
    const { chart, duration } = spendChart([github], GAP_NOW, "good");
    expect(duration).toBe(31 * DAY);
    const lines = polylines(chart);
    // One base line over December, then the bright trailing slice.
    expect(lines.length).toBe(2);
    expect(lines[0].length).toBe(31);
    // It reaches the right edge: the grid stops where the line does, instead
    // of running on to 3 January and leaving the line short of the edge.
    expect(lines[0][30][0]).toBe(220);
    // The quiet 21st-31st settled into real zeros below the $5 days.
    const quiet = lines[0].slice(20).map(([, y]) => y);
    expect(new Set(quiet).size).toBe(1);
    expect(quiet[0]).toBeGreaterThan(lines[0][19][1]);
  });

  it("marks a day both its neighbours are missing", () => {
    // On 3 January a 2-day lag reaches 1 January, so the January side of the
    // hole is a single day with nothing to join it to.
    const github = source(
      [...NOVEMBER, ...run("2026-01-01", 1, 2)],
      2,
      "#58a6ff",
      ["2025-11", "2026-01"],
    );
    const { chart } = spendChart(
      [github],
      new Date("2026-01-03T09:00:00Z"),
      "good",
    );
    const lines = polylines(chart);
    // November is the only run of days long enough to draw a line through.
    expect(lines.length).toBe(1);
    expect(lines[0].length).toBe(11);
    // 1 January is drawn as a point of its own at the chart's right edge.
    const points = markers(chart);
    expect(points.length).toBe(1);
    expect(points[0][0]).toBe(220);
    // It sits above the $1 November days, at its own $2.
    expect(points[0][1]).toBeLessThan(lines[0][10][1]);
  });
});
