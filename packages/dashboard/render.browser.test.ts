import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "@std/assert";
import { renderTile } from "./tile-render.ts";
import {
  BOTTOM_CHART_RULES,
  DASHBOARD_GRID_RULE,
  LABELED_CELL_GRID_SHIFT,
  labeledCellGridRule,
  TILE_BOX_RULE,
  TILE_LABEL_RULE,
  tileContentRules,
} from "./chart-layout.ts";
import {
  TILE_LAYOUT_FIXTURES,
  type TileLayoutFixture,
} from "./tile-layout-fixtures.ts";
import {
  DURATION_LABEL_HEIGHT,
  SPARKLINE_HEIGHT,
} from "./tile-render-values.ts";

const pixel = (value: number): number => Math.round(value * 1000) / 1000;

function assertStandardTileLayout(
  root: HTMLElement,
  standard: readonly TileLayoutFixture[],
): void {
  const width = pixel(root.getBoundingClientRect().width);
  const tiles = new Map(
    [...root.querySelectorAll<HTMLElement>("[data-tile-id]")].map((tile) => [
      tile.dataset.tileId!,
      tile,
    ]),
  );
  assertEquals(tiles.size, standard.length);
  const benchmark = tiles.get("benchmark");
  assertExists(benchmark);
  const benchmarkHeadline = benchmark.querySelector<HTMLElement>(".big");
  const benchmarkSub = benchmark.querySelector<HTMLElement>(
    ".benchmark-count",
  );
  const benchmarkDuration = benchmark.querySelector<HTMLElement>(
    ".chart > span:last-child",
  );
  assertExists(benchmarkHeadline);
  assertExists(benchmarkSub);
  assertExists(benchmarkDuration);
  const benchmarkRect = benchmark.getBoundingClientRect();
  const headlineTop = pixel(
    benchmarkHeadline.getBoundingClientRect().top - benchmarkRect.top,
  );
  const subTop = pixel(
    benchmarkSub.getBoundingClientRect().top - benchmarkRect.top,
  );
  const durationTop = pixel(
    benchmarkDuration.getBoundingClientRect().top - benchmarkRect.top,
  );

  for (const { id, subSelector, view } of standard) {
    const tile = tiles.get(id);
    assertExists(tile);
    if (view.href) {
      assert(tile instanceof HTMLAnchorElement, `${id} must render as a link`);
      assertEquals(
        getComputedStyle(tile).display,
        "block",
        `${id} linked tile must retain block layout`,
      );
    }
    const tileRect = tile.getBoundingClientRect();
    const headline = tile.querySelector<HTMLElement>(".big");
    assertExists(headline);
    if (view.valueLabel !== undefined) {
      assertEquals(
        headline.title,
        view.valueLabel,
        `${id} truncated headline must expose its full text at ${width}px`,
      );
    }
    const header = tile.querySelector<HTMLElement>(".lbl");
    assertExists(header);
    assert(
      header.scrollWidth <= header.clientWidth,
      `${id} header overflows at ${width}px`,
    );
    const mtd = header.querySelector<HTMLElement>(".hmtd");
    if (mtd) {
      assertEquals(
        mtd.title,
        mtd.textContent,
        `${id} truncated MTD value must expose its full text at ${width}px`,
      );
    }
    assertEquals(
      pixel(headline.getBoundingClientRect().top - tileRect.top),
      headlineTop,
      `${id} headline must share the benchmark offset at ${width}px`,
    );
    const sub = tile.querySelector<HTMLElement>(subSelector ?? ".sub");
    if (view.sub !== undefined || subSelector !== undefined) {
      assertExists(sub, `${id} must render its subheading at ${width}px`);
      assertEquals(
        pixel(sub.getBoundingClientRect().top - tileRect.top),
        subTop,
        `${id} subheading must share the benchmark offset at ${width}px`,
      );
      if (sub.matches(".sub")) {
        assertEquals(
          sub.title,
          sub.textContent?.trim(),
          `${id} truncated subheading must expose its full text at ${width}px`,
        );
      }
    }
    const duration = tile.querySelector<HTMLElement>(
      ".chart > span:last-child",
    );
    if (view.duration !== undefined) {
      assertExists(duration, `${id} must render its duration at ${width}px`);
      assertEquals(
        pixel(duration.getBoundingClientRect().top - tileRect.top),
        durationTop,
        `${id} duration must share the benchmark offset at ${width}px`,
      );
    }
    assert(
      pixel(tileRect.height) <= pixel(benchmarkRect.height),
      `${id} is ${pixel(tileRect.height)}px tall at ${width}px; benchmarks is ${
        pixel(benchmarkRect.height)
      }px`,
    );
  }
}

Deno.test("every standard tile shares text baselines and fits under benchmarks", async () => {
  const standard = TILE_LAYOUT_FIXTURES.filter(({ wide }) => !wide);
  const tiles = standard.map(({ id, view }) => renderTile(view, id)).join("");
  const fixture = document.createElement("div");
  fixture.innerHTML = `<style>
    .layout-wall{width:1100px;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
    .layout-minimum{width:220px;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
    ${DASHBOARD_GRID_RULE}
    ${TILE_BOX_RULE}
    ${BOTTOM_CHART_RULES}
    ${tileContentRules(SPARKLINE_HEIGHT, DURATION_LABEL_HEIGHT)}
    .cells.labeled .cell{display:block}
  </style><div class="grid layout-wall">${tiles}</div>
  <div class="grid layout-minimum">${tiles}</div>`;
  document.body.append(fixture);

  try {
    await new Promise(requestAnimationFrame);
    const wall = fixture.querySelector<HTMLElement>(".layout-wall");
    const minimum = fixture.querySelector<HTMLElement>(".layout-minimum");
    assertExists(wall);
    assertExists(minimum);
    assertStandardTileLayout(wall, standard);
    assertStandardTileLayout(minimum, standard);
  } finally {
    fixture.remove();
  }
});

Deno.test("the trust grid preserves tile text and moves above its duration label", async () => {
  const cells = Array.from(
    { length: 160 },
    () => `<span class="cell" style="background:#fff"></span>`,
  ).join("");
  const fixture = document.createElement("div");
  fixture.innerHTML = `<style>
    .row-test{display:flex;gap:10px}
    .tile{width:220px;height:115px}
    ${BOTTOM_CHART_RULES}
    ${TILE_LABEL_RULE}
    .height-control{height:15px}
    .big{height:36px;font:30px/36px sans-serif}
    .sub{height:15px;margin:5px 0 0;font:10px/15px sans-serif}
    .chart{position:relative;width:220px}
    .control-chart{position:relative;height:28px;margin-top:9px}
    .cells{display:grid;grid-template-columns:repeat(40,1fr);gap:1px}
    ${labeledCellGridRule(SPARKLINE_HEIGHT, DURATION_LABEL_HEIGHT)}
    .cells.labeled .cell{display:block;height:4px}
    .duration-test{position:absolute;bottom:0;height:9px}
  </style>
  <div class="row-test">
    <div class="tile bottom-chart trust-test">
      <div class="lbl">labs ci trust</div>
      <div class="big">90%</div>
      <div class="sub">first-try green</div>
      <div class="chart">
        <div class="cells labeled">${cells}</div>
        <span class="duration-test">3 days</span>
      </div>
    </div>
    <div class="tile control-test">
      <div class="lbl">labs ci duration<span class="height-control"></span></div>
      <div class="big">15m</div>
      <div class="sub">median</div>
      <div class="control-chart"><span class="duration-test">4 days</span></div>
    </div>
  </div>`;
  document.body.append(fixture);

  try {
    await new Promise(requestAnimationFrame);
    const grid = fixture.querySelector<HTMLElement>(".cells.labeled");
    const cell = grid?.querySelector<HTMLElement>(".cell");
    const lastCell = grid?.querySelector<HTMLElement>(".cell:last-child");
    const trust = fixture.querySelector<HTMLElement>(".trust-test");
    const control = fixture.querySelector<HTMLElement>(".control-test");
    const durationLabel = trust?.querySelector<HTMLElement>(".duration-test");
    assertExists(grid);
    assertExists(cell);
    assertExists(lastCell);
    assertExists(durationLabel);
    assertExists(trust);
    assertExists(control);
    const controlDurationLabel = control.querySelector<HTMLElement>(
      ".duration-test",
    );
    assertExists(controlDurationLabel);

    for (const selector of [".lbl", ".big", ".sub"]) {
      const trustText: HTMLElement | null = trust.querySelector(selector);
      const controlText: HTMLElement | null = control.querySelector(selector);
      assertExists(trustText);
      assertExists(controlText);
      assertEquals(
        trustText.getBoundingClientRect().top,
        controlText.getBoundingClientRect().top,
      );
      assertEquals(
        trustText.getBoundingClientRect().bottom,
        controlText.getBoundingClientRect().bottom,
      );
    }
    assertEquals(
      durationLabel.getBoundingClientRect().bottom,
      controlDurationLabel.getBoundingClientRect().bottom,
    );

    const trustLabel = trust.querySelector<HTMLElement>(".lbl");
    const trustHeadline = trust.querySelector<HTMLElement>(".big");
    const controlHeadline = control.querySelector<HTMLElement>(".big");
    assertExists(trustLabel);
    assertExists(trustHeadline);
    assertExists(controlHeadline);
    trustLabel.style.lineHeight = "normal";
    assertNotEquals(
      trustHeadline.getBoundingClientRect().top,
      controlHeadline.getBoundingClientRect().top,
    );
    trustLabel.style.removeProperty("line-height");

    grid.style.marginTop = "11.5px";
    assertNotEquals(
      durationLabel.getBoundingClientRect().bottom,
      controlDurationLabel.getBoundingClientRect().bottom,
    );
    grid.style.removeProperty("margin-top");

    const shiftedCellTop = cell.getBoundingClientRect().top;
    const shiftedGapBelow = durationLabel.getBoundingClientRect().top -
      lastCell.getBoundingClientRect().bottom;
    const labelBottom = durationLabel.getBoundingClientRect().bottom;

    grid.style.transform = "none";
    assertEquals(
      shiftedCellTop,
      cell.getBoundingClientRect().top - LABELED_CELL_GRID_SHIFT,
    );
    assertEquals(
      shiftedGapBelow,
      durationLabel.getBoundingClientRect().top -
        lastCell.getBoundingClientRect().bottom + LABELED_CELL_GRID_SHIFT,
    );
    assertEquals(labelBottom, durationLabel.getBoundingClientRect().bottom);
  } finally {
    fixture.remove();
  }
});
