// Unit tests for the pure helpers. No network, subprocess, or filesystem.
import { assert, assertEquals } from "@std/assert";
import { budgetStatus, clampInt, concDot, daysLabel, durationTag, escapeHtml, friendlyError, humanDur, humanSpan, landingHref, lighten, multiSparkline, readBudget, sparkline, strip, thin, usd } from "./lib.ts";

Deno.test("landingHref: squash-merge trailing (#N) -> the PR", () => {
  assertEquals(
    landingHref("packages/ts-transformers tests (#4435)", "sha", "commontoolsinc/labs"),
    "https://github.com/commontoolsinc/labs/pull/4435",
  );
});

Deno.test("landingHref: merge commit -> the PR", () => {
  assertEquals(landingHref("Merge pull request #12 from x/y", "sha", "o/r"), "https://github.com/o/r/pull/12");
});

Deno.test("landingHref: a mid-message #ref does NOT mislink -> commit page", () => {
  assertEquals(landingHref("fix: follow-ups from #4401 review", "sha1", "o/r"), "https://github.com/o/r/commit/sha1");
});

Deno.test("landingHref: parses only the first line", () => {
  assertEquals(landingHref("title (#7)\n\nbody mentioning (#999)", "sha", "o/r"), "https://github.com/o/r/pull/7");
});

Deno.test("concDot: only genuine failures are red", () => {
  assertEquals(concDot("success", 1), "green");
  assertEquals(concDot("success", 2), "grey"); // passed only on retry
  assertEquals(concDot("failure", 1), "red");
  assertEquals(concDot("timed_out", 1), "red");
  assertEquals(concDot("cancelled", 1), "grey"); // non-verdict, not a failure
  assertEquals(concDot(null, 1), "grey");
});

Deno.test("daysLabel: consistent 'x days' text", () => {
  assertEquals(daysLabel(5), "5 days");
  assertEquals(daysLabel(1), "1 day");
  assertEquals(daysLabel(0), "<1 day");
});

Deno.test("humanSpan: days, else hours, else minutes", () => {
  assertEquals(humanSpan(5 * 86_400_000), "5 days"); // >= 1 day -> daysLabel
  assertEquals(humanSpan(86_400_000), "1 day");
  assertEquals(humanSpan(8 * 3_600_000), "8 hours"); // sub-day -> hours
  assertEquals(humanSpan(3_600_000), "1 hour");
  assertEquals(humanSpan(30 * 60_000), "30 min"); // sub-hour -> minutes
  assertEquals(humanSpan(0), "1 min");
});

Deno.test("humanDur", () => {
  assertEquals(humanDur(5 * 60_000), "5m");
  assertEquals(humanDur(90 * 60_000), "1h 30m");
  assertEquals(humanDur(26 * 3_600_000), "1d 2h");
});

Deno.test("clampInt: clamps to bounds and falls back on empty/invalid", () => {
  assertEquals(clampInt("50", 60, 10, 150), 50);
  assertEquals(clampInt("500", 60, 10, 150), 150);
  assertEquals(clampInt("5", 60, 10, 150), 10);
  assertEquals(clampInt("", 60, 10, 150), 60);
  assertEquals(clampInt(null, 60, 10, 150), 60);
  assertEquals(clampInt("abc", 60, 10, 150), 60);
});

Deno.test("friendlyError: raw errors become short calm phrases", () => {
  assertEquals(
    friendlyError("GitHub API repos/o/r/actions/workflows/deno.yml/runs failed: error connecting to api"),
    "source unreachable",
  );
  assertEquals(friendlyError("error sending request for url"), "source unreachable");
  assertEquals(friendlyError("HTTP 404: Not Found"), "not found");
  assertEquals(friendlyError("HTTP 403: rate limit exceeded"), "rate limit hit");
  assertEquals(friendlyError("Bad credentials"), "auth failed");
  assertEquals(friendlyError("GitHub API x: set GH_TOKEN or GITHUB_TOKEN"), "set GH_TOKEN");
  assertEquals(friendlyError("something weird"), "temporarily unavailable");
});

Deno.test("budgetStatus / readBudget: good ≤ budget, warn ≤ 1.25×, bad beyond; unset never alarms", () => {
  assertEquals(budgetStatus(50, 100), "good");
  assertEquals(budgetStatus(100, 100), "good");
  assertEquals(budgetStatus(125, 100), "warn");
  assertEquals(budgetStatus(126, 100), "bad");
  assertEquals(budgetStatus(9999, NaN), "good"); // unset budget never alarms
  assert(Number.isNaN(readBudget(undefined)));
  assert(Number.isNaN(readBudget("")));
  assert(Number.isNaN(readBudget("   ")));
  assertEquals(readBudget("100"), 100);
});

Deno.test("usd: whole dollars, or cents under a dollar", () => {
  assertEquals(usd(0), "$0");
  assertEquals(usd(0.45), "45¢");
  assertEquals(usd(0.05), "5¢");
  assertEquals(usd(0.004), "$0"); // rounds to 0¢ -> $0
  assertEquals(usd(0.99), "99¢");
  assertEquals(usd(0.999), "$1"); // 99.9¢ rounds up to a dollar
  assertEquals(usd(1), "$1");
  assertEquals(usd(1955.4), "$1955");
});

Deno.test("escapeHtml", () => {
  assertEquals(escapeHtml(`<a href="x">&`), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

Deno.test("sparkline: highlight overdraws the trailing count on the same scale", () => {
  const vals = Array.from({ length: 50 }, (_, i) => i); // strictly increasing
  const svg = sparkline(vals, "#111", { count: 10, color: "#eee" });
  const lines = [...svg.matchAll(/<polyline points="([^"]*)" fill="none" stroke="([^"]*)"/g)];
  assertEquals(lines.length, 2); // base + highlight
  const base = lines[0][1].trim().split(" ");
  const tail = lines[1][1].trim().split(" ");
  assertEquals(lines[0][2], "#111");
  assertEquals(lines[1][2], "#eee");
  assertEquals(base.length, 50);
  assertEquals(tail.length, 10); // exactly the median window
  assertEquals(tail[tail.length - 1], base[base.length - 1]); // ends on the same point
  assertEquals(tail[0], base[base.length - 10]); // starts at the 10th-from-last point
});

Deno.test("sparkline: scale normalizes to the recent runs, clipping old spikes", () => {
  const y = (pt: string) => parseFloat(pt.split(",")[1]);
  const ysOf = (svg: string) => svg.match(/<polyline points="([^"]*)"/)![1].trim().split(" ").map(y);
  // One huge old run, then four modest recent runs.
  const spiky = ysOf(sparkline([100, 10, 11, 12, 13], "#111", { count: 4, color: "#eee" }));
  assert(spiky[0] < 0, `old spike should clip above the viewport, got y=${spiky[0]}`);
  const recent = spiky.slice(1);
  assert(Math.max(...recent) - Math.min(...recent) > 12, "recent runs should span most of the height");
  // Without the spike, the same recent runs land on the same scale (spike-independent).
  const clean = ysOf(sparkline([12, 10, 11, 12, 13], "#111", { count: 4, color: "#eee" }));
  assertEquals(clean.slice(1), recent);
});

Deno.test("sparkline: highlight scaleAll keeps the whole series in view, still drawing the tail", () => {
  const y = (pt: string) => parseFloat(pt.split(",")[1]);
  const polys = (svg: string) => [...svg.matchAll(/<polyline points="([^"]*)"/g)].map((m) => m[1].trim().split(" ").map(y));
  // Same one-huge-old / modest-recent data, but scaleAll scales to every point.
  const lines = polys(sparkline([100, 10, 11, 12, 13], "#111", { count: 4, color: "#eee", scaleAll: true }));
  assertEquals(lines.length, 2); // base + highlighted tail
  const [base, tail] = lines;
  // The spike is now the series max, so it stays in view (not clipped past the top).
  assert(base[0] >= 0, `spike should stay in view with scaleAll, got y=${base[0]}`);
  assertEquals(base[0], Math.min(...base), "the spike is the highest point (smallest y)");
  assertEquals(tail.length, 4); // the tail still covers the trailing 4 points
});

Deno.test("durationTag renders an auto-formatted span; sparkline itself has no label", () => {
  const tag = durationTag(25 * 86_400_000);
  assert(tag.includes(">25 days</span>"), "the ms duration is auto-formatted to '25 days'");
  assert(/position:absolute[^"]*left:1px[^"]*bottom:0/.test(tag), "pinned to the bottom-left corner");
  assert(!/<text/.test(tag), "must be HTML, not an SVG <text> element");
  // sparkline no longer draws any label itself — it returns a bare <svg>.
  const svg = sparkline([10, 11, 12, 13], "#111", { count: 2, color: "#eee" });
  assert(svg.startsWith("<svg") && svg.endsWith("</svg>"), "bare svg, no wrapper or label");
  assert([...svg.matchAll(/<polyline/g)].length === 2, "the line + highlight are still drawn");
});

Deno.test("sparkline: fadeFrom makes the base line a gradient to color at the highlight edge", () => {
  const svg = sparkline([30, 20, 10, 11, 12, 13], "#727882", { count: 3, color: "#c7ccd4" }, "#101010");
  assert(/<linearGradient id="[^"]+" x1="0" y1="0" x2="1" y2="0"/.test(svg), "horizontal gradient defined");
  assert(svg.includes('<stop offset="0" stop-color="#101010"'), "far-left stop is fadeFrom");
  assert(svg.includes('stop-color="#727882"'), "the gradient resolves to the base color");
  const id = svg.match(/id="([^"]+)"/)![1];
  assert(svg.includes(`stroke="url(#${id})"`), "the base line strokes with the gradient");
  assert(svg.includes('stroke="#c7ccd4"'), "the highlight keeps its flat color");
  // transition reaches base color by the tile midpoint (0.5), before the
  // highlight edge at (6-3)/(6-1) = 0.6
  assert(svg.includes('offset="0.500"'), "gradient reaches base color by the midpoint");
  // no fadeFrom -> flat base stroke, no gradient
  assert(!/<linearGradient/.test(sparkline([1, 2, 3], "#727882", { count: 2, color: "#eee" })), "no fade without fadeFrom");
});

Deno.test("multiSparkline: overlaid lines on one shared scale; < 2 points is empty", () => {
  const svg = multiSparkline([
    { vals: [1, 2, 3], color: "#0a0" },
    { vals: [4, 5, 6], color: "#00a" },
  ]);
  assertEquals([...svg.matchAll(/<polyline/g)].length, 2);
  assert(svg.includes('stroke="#0a0"'), "first series color present");
  assert(svg.includes('stroke="#00a"'), "second series color present");
  // Shared scale (min 1, max 6): the second series sits above the first.
  const yOf = (stroke: string) => {
    const pts = svg.match(new RegExp(`points="([^"]*)"[^>]*stroke="${stroke}"`))![1].split(" ");
    return parseFloat(pts[0].split(",")[1]);
  };
  assert(yOf("#00a") < yOf("#0a0"), "higher values render higher (smaller y) on the shared scale");
  assertEquals(multiSparkline([{ vals: [5], color: "#000" }]), ""); // < 2 points
  assertEquals(multiSparkline([]), "");

  // Per-series label: the last value, right-anchored, in the line's color.
  const labeled = multiSparkline([
    { vals: [1, 2, 3], color: "#0a0", label: "3" },
    { vals: [4, 5, 6], color: "#00a", label: "6" },
  ]);
  assert(/right:0[^"]*color:#0a0[^"]*">3<\/span>/.test(labeled), "team label at right, in the line color");
  assert(/right:0[^"]*color:#00a[^"]*">6<\/span>/.test(labeled), "visitor label at right, in the line color");
});

Deno.test("multiSparkline: fadeFrom gradients each line", () => {
  const svg = multiSparkline(
    [
      { vals: [1, 2, 3], color: "#0a0", label: "3" },
      { vals: [4, 5, 6], color: "#00a", label: "6" },
    ],
    { fadeFrom: "#111" },
  );
  // each line fades from fadeFrom (left) to its own color at the midpoint
  assert(svg.includes('stop-color="#111"/><stop offset="0.5" stop-color="#0a0"'), "team line fades to its color");
  assert(svg.includes('stop-color="#111"/><stop offset="0.5" stop-color="#00a"'), "visitor line fades to its color");
  assert(/stroke="url\(#mspk-[0-9a-fA-F]+-[0-9a-fA-F]+-\d+\)"/.test(svg), "lines stroke via their gradient");
  // no fadeFrom -> flat strokes, no gradient defs
  assert(
    !/<linearGradient/.test(multiSparkline([{ vals: [1, 2], color: "#0a0" }, { vals: [3, 4], color: "#00a" }])),
    "no gradient without fadeFrom",
  );
});

Deno.test("multiSparkline: overlapping end-labels are spread apart, not stacked", () => {
  // Both lines end at the same value -> same natural label height -> must separate.
  const svg = multiSparkline([
    { vals: [5, 5, 0], color: "#0a0", label: "$100" },
    { vals: [1, 1, 0], color: "#00a", label: "$50" },
  ]);
  // Match only the label spans (top:...px;transform), not the container's margin-top.
  const tops = [...svg.matchAll(/top:([0-9.]+)px;transform/g)].map((m) => parseFloat(m[1]));
  assertEquals(tops.length, 2);
  assert(Math.abs(tops[0] - tops[1]) >= 11, `labels should stay ~12px apart, got ${tops}`);
  // And they stay within the 32px-tall label band.
  for (const t of tops) assert(t >= 0 && t <= 32, `label ${t} within band`);
});

Deno.test("lighten: blends a color toward white; non-hex is left alone", () => {
  assertEquals(lighten("#000000", 0.5), "#808080"); // halfway to white
  assertEquals(lighten("#ffffff", 0.5), "#ffffff"); // already white
  assertEquals(lighten("#000", 0.5), "#808080"); // 3-digit shorthand expands
  assertEquals(lighten("url(#grad)"), "url(#grad)"); // not a hex color
  const lit = lighten("#10a37f");
  assert(/^#[0-9a-f]{6}$/.test(lit) && lit !== "#10a37f");
  assert(parseInt(lit.slice(1, 3), 16) > 0x10, "each channel moves toward white");
});

Deno.test("multiSparkline: highlight redraws the trailing slice in a lighter tint", () => {
  const svg = multiSparkline(
    [{ vals: [1, 2, 3, 4, 5], color: "#10a37f", label: "5" }],
    { highlight: { count: 2 }, fadeFrom: "#111111" },
  );
  // The base line plus the lighter trailing slice drawn over it.
  assertEquals([...svg.matchAll(/<polyline/g)].length, 2);
  assert(svg.includes(`stroke="${lighten("#10a37f")}"`), "the slice is a lighter tint of the line's own color");
  // The base still fades up to the line's own color by the midpoint.
  assert(svg.includes('stop offset="0.5" stop-color="#10a37f"'), "gradient handoff at the midpoint");
  assert(!svg.includes("stroke-opacity"), "a lighter tint, not a flat dim");
  // No highlight -> just the one line, no tint.
  const plain = multiSparkline([{ vals: [1, 2, 3], color: "#10a37f", label: "3" }], { fadeFrom: "#111111" });
  assertEquals([...plain.matchAll(/<polyline/g)].length, 1);
});

Deno.test("a slice covering the whole series leaves the line in its own color", () => {
  // A window at least as long as the series marks nothing off, so drawing it would
  // repaint the whole line in the tint and lose the line's own color.
  const whole = multiSparkline(
    [{ vals: [1, 2, 3, 4], color: "#10a37f", label: "4" }],
    { highlight: { count: 4 }, fadeFrom: "#111111" },
  );
  assertEquals([...whole.matchAll(/<polyline/g)].length, 1, "base only, no tint over it");
  assert(!whole.includes(lighten("#10a37f")), "the line keeps its own color");
  // Same for a count past the end of the series.
  const over = multiSparkline([{ vals: [1, 2, 3, 4], color: "#10a37f" }], { highlight: { count: 9 } });
  assertEquals([...over.matchAll(/<polyline/g)].length, 1);
  // The single-color sparkline behaves the same way.
  const one = sparkline([1, 2, 3, 4], "#727882", { count: 4, color: "#c7ccd4" }, "#111111");
  assertEquals([...one.matchAll(/<polyline/g)].length, 1, "base only");
  assert(!one.includes("#c7ccd4"), "the line keeps its own color");
});

Deno.test("multiSparkline: every base is drawn before any tint", () => {
  // Interleaving base and tint per series lets a later line's base paint over an
  // earlier line's tint wherever the two cross inside the window.
  const svg = multiSparkline([
    { vals: [1, 5, 1, 5], color: "#10a37f" },
    { vals: [5, 1, 5, 1], color: "#d97757" },
  ], { highlight: { count: 2 } });
  const strokes = [...svg.matchAll(/<polyline[^>]*stroke="([^"]*)"/g)].map((m) => m[1]);
  assertEquals(strokes, ["#10a37f", "#d97757", lighten("#10a37f"), lighten("#d97757")]);
});

Deno.test("sparkline: xs place points on a shared axis", () => {
  const coords = (svg: string) => svg.match(/<polyline points="([^"]*)"/)![1].trim().split(" ");
  const x0 = (p: string[]) => parseFloat(p[0].split(",")[0]);
  const xLast = (p: string[]) => parseFloat(p[p.length - 1].split(",")[0]);
  // A late-starting series: on the right 40% of the axis (ends at the right edge).
  const late = coords(sparkline([1, 2, 3], "#111", undefined, undefined, [0.6, 0.8, 1.0]));
  assert(Math.abs(x0(late) - 0.6 * 220) < 0.5, "starts at 60% of the width");
  assert(Math.abs(xLast(late) - 220) < 0.5, "ends at the right edge");
  // A stale series: ends short of the right edge.
  const stale = coords(sparkline([1, 2, 3], "#111", undefined, undefined, [0, 0.35, 0.7]));
  assertEquals(x0(stale), 0);
  assert(Math.abs(xLast(stale) - 0.7 * 220) < 0.5, "ends short of the right edge");
  // No xs -> evenly spaced full width.
  assertEquals(x0(coords(sparkline([1, 2, 3], "#111"))), 0);
});

Deno.test("thin: caps length, keeps the first and last, evenly spaced", () => {
  assertEquals(thin([1, 2, 3], 5), [1, 2, 3]); // already within max -> unchanged
  const t = thin(Array.from({ length: 1000 }, (_, i) => i), 100);
  assertEquals(t.length, 100);
  assertEquals(t[0], 0);
  assertEquals(t[t.length - 1], 999);
  // strictly increasing (no repeats when downsampling a dense range)
  assert(t.every((v, i) => i === 0 || v > t[i - 1]), "evenly spaced, no repeats");
});

Deno.test("strip: each cell links to that run's CI results in a new tab", () => {
  const html = strip([
    { outcome: "green", href: "https://github.com/o/r/actions/runs/1" },
    { outcome: "red", href: "https://github.com/o/r/actions/runs/2" },
  ], 40);
  assertEquals([...html.matchAll(/<a class="cell"/g)].length, 2);
  assert(html.includes('href="https://github.com/o/r/actions/runs/1"'), "first run link");
  assert(html.includes('href="https://github.com/o/r/actions/runs/2"'), "second run link");
  assert(html.includes('target="_blank"'), "opens in a new tab");
  assertEquals(strip([], 40), ""); // empty -> nothing
});

Deno.test("sparkline: no highlight is a single line; a short series is empty", () => {
  assertEquals([...sparkline([1, 2, 3], "#111").matchAll(/<polyline/g)].length, 1);
  // A degenerate highlight (< 2 points) adds no second line.
  assertEquals([...sparkline([1, 2, 3], "#111", { count: 1, color: "#eee" }).matchAll(/<polyline/g)].length, 1);
  assertEquals(sparkline([5], "#111"), "");
});
