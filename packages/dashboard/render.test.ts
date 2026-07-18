// Rendering tests: renderTile turns a TileView into markup, shell wraps the grid
// in the page. Pure string work — no server, no network, no subprocess.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Status, TileView } from "./types.ts";
import { formatViewerTimes, renderTile, shell, SHELL_VERSION } from "./render.ts";
import { humanSpan } from "./lib.ts";
import { REPO } from "./config.ts";

function view(over: Partial<TileView> = {}): TileView {
  return { label: "labs ci", status: "good", ...over };
}

Deno.test("renderTile: status drives the tile class, the dot color and the headline color", () => {
  const dots: Record<Status, string> = { good: "green", warn: "amber", bad: "red", unknown: "grey" };
  for (const [status, dot] of Object.entries(dots) as [Status, string][]) {
    const html = renderTile(view({ status, value: "passing" }));
    assertStringIncludes(html, `class="tile ${status}"`);
    assertStringIncludes(html, `<span class="dot ${dot}"></span>`);
    assertStringIncludes(html, `<p class="big ${status}">passing</p>`);
  }
});

Deno.test("renderTile: no href -> a plain div, not a link", () => {
  const html = renderTile(view());
  assert(html.startsWith(`<div class="tile good">`), html);
  assert(html.endsWith("</div>"));
  assert(!html.includes("<a "), "nothing to drill into, so no anchor");
  assert(!html.includes(" link"), "the link class is only for tiles that link");
});

Deno.test("renderTile: a server-supplied id becomes the stable update key", () => {
  assertStringIncludes(renderTile(view(), "labs-ci"), `data-tile-id="labs-ci"`);
  assertStringIncludes(
    renderTile(view({ href: "/ci" }), "labs-ci-duration"),
    `data-tile-id="labs-ci-duration"`,
  );
});

Deno.test("renderTile: an http href is an anchor that opens a new tab; a local one stays in place", () => {
  const external = renderTile(view({ href: "https://github.com/o/r/actions" }));
  assertStringIncludes(external, `<a class="tile good link" href="https://github.com/o/r/actions" target="_blank" rel="noopener">`);
  const local = renderTile(view({ href: "/bench" }));
  assertStringIncludes(local, `<a class="tile good link" href="/bench">`);
  assert(!local.includes("target="), "a drill-down on this server replaces the page");
});

Deno.test("renderTile: wide adds the class the shell lays out below the grid", () => {
  assertStringIncludes(renderTile(view(), undefined, true), `class="tile good wide"`);
  assertStringIncludes(renderTile(view({ href: "/x" }), undefined, true), `class="tile good link wide"`);
  assert(!renderTile(view()).includes("wide"));
});

Deno.test("renderTile: an absent value/sub/hint/aside renders nothing rather than an empty element", () => {
  const html = renderTile(view());
  assertEquals(html, `<div class="tile good"><p class="lbl"><span class="dot green"></span> labs ci<span class="spacer"></span></p></div>`);
});

Deno.test("renderTile: label and sub are escaped — a hostile label cannot inject markup", () => {
  const html = renderTile(view({
    label: `<img src=x onerror="alert(1)">`,
    sub: `a & b "quoted" <script>`,
  }));
  assert(!html.includes("<img"), "the label's tag is defanged");
  assert(!html.includes("<script>"), "the sub line's tag is defanged");
  assertStringIncludes(html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assertStringIncludes(html, `<p class="sub">a &amp; b &quot;quoted&quot; &lt;script&gt;</p>`);
});

Deno.test("renderTile: value, extra and aside are trusted html; hint is escaped", () => {
  const html = renderTile(view({
    value: `<b>42</b>`,
    aside: `<span class="hmtd">$12</span>`,
    extra: `<svg viewBox="0 0 1 1"></svg>`,
    hint: `commits ↗ <not a tag>`,
  }));
  // A tile builds these itself, escaping any data it puts in them.
  assertStringIncludes(html, `<p class="big good"><b>42</b></p>`);
  assertStringIncludes(html, `<span class="hmtd">$12</span>`);
  assertStringIncludes(html, `<svg viewBox="0 0 1 1"></svg>`);
  // The hint is plain text from the tile, so the renderer escapes it.
  assertStringIncludes(html, `<span class="drill">commits ↗ &lt;not a tag&gt;</span>`);
});

Deno.test("renderTile: the aside and hint sit after the label, separated by the spacer", () => {
  const html = renderTile(view({ aside: "<i>mtd</i>", hint: "runs" }));
  assertStringIncludes(
    html,
    `<p class="lbl"><span class="dot green"></span> labs ci<span class="spacer"></span><i>mtd</i><span class="drill">runs</span></p>`,
  );
});

Deno.test("renderTile: a duration wraps the chart so the span can be pinned to its corner", () => {
  const html = renderTile(view({ extra: "<svg></svg>", duration: 25 * 86_400_000 }));
  assertStringIncludes(html, `<div style="position:relative"><svg></svg>`);
  // The corner tag is the auto-formatted span, and it is inside the wrapper.
  assertStringIncludes(html, ">25 days</span></div>");
  assertStringIncludes(html, "position:absolute");
});

Deno.test("renderTile: no duration leaves extra unwrapped", () => {
  const html = renderTile(view({ extra: "<svg></svg>" }));
  assertStringIncludes(html, "<svg></svg>");
  assert(!html.includes("position:relative"), "nothing to position, so no wrapper");
});

Deno.test("renderTile: a duration with no chart draws nothing to label", () => {
  // The span labels the chart's corner. With no chart the wrapper has no height, so
  // the label would sit on top of the sub line. A tile whose series is too short to
  // plot still reports a span, so this happens: dau's first day, for one.
  const html = renderTile(view({ sub: "things", duration: 90 * 60_000 }));
  assert(!html.includes("position:relative"), "nothing to position, so no wrapper");
  assert(!html.includes(humanSpan(90 * 60_000)), "and no orphaned span label");
  assertStringIncludes(html, `<p class="sub">things</p>`); // the sub is left alone
});

Deno.test("renderTile: the body order is label, headline, sub, chart", () => {
  const html = renderTile(view({ value: "42", sub: "things", extra: "<svg></svg>" }));
  const at = (needle: string) => html.indexOf(needle);
  assert(at(`class="lbl"`) < at(`class="big`), "label first");
  assert(at(`class="big`) < at(`class="sub"`), "headline above the sub line");
  assert(at(`class="sub"`) < at("<svg>"), "the chart is last");
});

Deno.test("shell: the grid and the wide tiles land in their own slots", () => {
  const html = shell(
    `<div class="tile good">g</div>`,
    `<div class="tile bad wide">w</div>`,
    3,
    30_000,
    SHELL_VERSION,
  );
  assertStringIncludes(html, `<div class="grid" id="dashboard-grid"><div class="tile good">g</div></div>`);
  assertStringIncludes(html, `<div id="dashboard-wide"><div class="tile bad wide">w</div></div>`);
  // Wide tiles sit after the grid, not inside it.
  assert(html.indexOf(`class="grid"`) < html.indexOf(`tile bad wide`));
  assert(html.startsWith("<!doctype html>"), "a whole page, not a fragment");
  assertStringIncludes(html, "<title>Fabric wall — LIVE</title>");
  assertStringIncludes(html, "</body></html>");
});

Deno.test("shell: the freshness age and the refresh interval reach both the text and the script", () => {
  const html = shell("", "", 7, 45_000, SHELL_VERSION);
  assertStringIncludes(html, `<span id="agotext">updated 7s ago</span>`);
  assertStringIncludes(html, "const REFRESH = 45000;");
  assertStringIncludes(html, `const SHELL_VERSION = ${SHELL_VERSION};`);
  assertStringIncludes(html, "let base = 7;");
  assertStringIncludes(html, `new EventSource('/events')`);
  assertStringIncludes(
    html,
    `es.onmessage = (e) => { if (e.data === 'reload') location.reload(); };`,
  );
  assertStringIncludes(html, `es.addEventListener('update'`);
  assertStringIncludes(html, `reconcileTiles(grid, update.gridHtml)`);
  assertStringIncludes(html, `reconcileTiles(wide, update.wideHtml)`);
  assertStringIncludes(
    html,
    `if (update.shellVersion !== SHELL_VERSION) { location.reload(); return; }`,
  );
  assertEquals(html.match(/location\.reload\(\)/g)?.length, 2);
  assertStringIncludes(html, `if (current.outerHTML === next.outerHTML) return current;`);
  assertStringIncludes(html, `nextScroller.scrollTop = scrollTop`);
});

Deno.test("formatViewerTimes: the viewer's formatter replaces the UTC fallback", () => {
  const time = { dateTime: "2024-01-02T17:05:00Z", textContent: "17:05 UTC" };
  const viewerTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatViewerTimes([time], viewerTime);
  assertEquals(time.textContent, "09:05");
});

Deno.test("shell: the browser runs the viewer-time formatter", () => {
  const html = shell("", "", 0, 30_000, SHELL_VERSION);
  const source = formatViewerTimes.toString();
  assertStringIncludes(source, `time[data-viewer-time][datetime]`);
  assert(!source.includes("timeZone"), "the default formatter must use the viewer's timezone");
  assertStringIncludes(html, source);
  assertStringIncludes(html, "formatViewerTimes();");
  const localizeUpdate = html.indexOf(
    `formatViewerTimes(template.content.querySelectorAll('time[data-viewer-time][datetime]'));`,
  );
  const compareMarkup = html.indexOf("if (current.outerHTML === next.outerHTML)");
  assert(localizeUpdate >= 0, "live updates localize their timestamps");
  assert(
    localizeUpdate < compareMarkup,
    "live updates are localized before their markup is compared",
  );
});

Deno.test("shell: the repo name in the header is escaped", () => {
  assertStringIncludes(
    shell("", "", 0, 1000, SHELL_VERSION),
    `<span>${REPO.replace(/&/g, "&amp;")}</span>`,
  );
});
