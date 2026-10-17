/**
 * cf-map in a real browser: it opens on the bounds its `bounds` cell holds,
 * and its `cf-bounds-change` says whether a person moved the map or cf-map
 * moved it itself (a feature fit, a bound value, a resize).
 */

import { expect } from "@std/expect";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFMap } from "./index.ts";
import type { Bounds, CfBoundsChangeDetail, MapValue } from "./types.ts";

/** A box around Paris, far from cf-map's default view of San Francisco. */
const PARIS: Bounds = { north: 48.9, south: 48.82, east: 2.42, west: 2.27 };
const PARIS_CENTER = { lat: 48.86, lng: 2.345 };

type Mounted = { map: CFMap; [Symbol.dispose]: () => void };

/** A sized cf-map in the page, set up by `configure` before it renders. */
async function mounted(configure: (map: CFMap) => void): Promise<Mounted> {
  const map = new CFMap();
  map.style.display = "block";
  map.style.width = "400px";
  map.style.height = "300px";
  configure(map);
  document.body.append(map);
  await map.updateComplete;
  return { map, [Symbol.dispose]: () => map.remove() };
}

/** The `.map-container` Leaflet draws into. */
function container(map: CFMap): HTMLElement {
  const element = map.shadowRoot?.querySelector(".map-container");
  if (!(element instanceof HTMLElement)) {
    throw new Error("cf-map did not render its container");
  }
  return element;
}

/** The next `cf-bounds-change` the map emits. */
function nextBoundsChange(map: CFMap): Promise<CfBoundsChangeDetail> {
  return new Promise((resolve) => {
    map.addEventListener("cf-bounds-change", (event) => {
      if (event instanceof CustomEvent) resolve(event.detail);
    }, { once: true });
  });
}

/** The longitude `pixels` of Web Mercator map span at `zoom`. */
function lngSpan(pixels: number, zoom: number): number {
  return pixels * 360 / (256 * 2 ** zoom);
}

/** Whether `inner`'s box lies inside `outer`'s. */
function inside(inner: DOMRect, outer: DOMRect): boolean {
  return inner.left >= outer.left && inner.right <= outer.right &&
    inner.top >= outer.top && inner.bottom <= outer.bottom;
}

Deno.test("cf-map opens on the bounds its bounds cell holds", async () => {
  using page = await mounted((map) => {
    map.bounds = createMockCellHandle(PARIS);
    map.value = { markers: [{ position: PARIS_CENTER }] };
  });
  const marker = container(page.map).querySelector(".leaflet-marker-icon");
  if (!marker) throw new Error("cf-map drew no marker");
  expect(
    inside(
      marker.getBoundingClientRect(),
      container(page.map).getBoundingClientRect(),
    ),
  ).toBe(true);
});

Deno.test("cf-map mounted hidden opens on its bound bounds once it is shown", async () => {
  const hidden = document.createElement("div");
  hidden.style.display = "none";
  document.body.append(hidden);
  try {
    const map = new CFMap();
    map.style.display = "block";
    map.style.width = "400px";
    map.style.height = "300px";
    map.bounds = createMockCellHandle(PARIS);
    map.value = { markers: [{ position: PARIS_CENTER }] };
    hidden.append(map);
    await map.updateComplete;

    // Shown, the map reports the fitted view as cf-map's own move: the Paris
    // box, not the whole world a map with no size fits it to.
    const shown = nextBoundsChange(map);
    hidden.style.display = "block";
    const detail = await shown;
    expect(detail.userInitiated).toBe(false);
    expect(detail.zoom).toBeGreaterThanOrEqual(11);
    expect(detail.bounds.north).toBeLessThan(49);
    expect(detail.bounds.south).toBeGreaterThan(48.7);
    const marker = container(map).querySelector(".leaflet-marker-icon");
    if (!marker) throw new Error("cf-map drew no marker");
    expect(
      inside(
        marker.getBoundingClientRect(),
        container(map).getBoundingClientRect(),
      ),
    ).toBe(true);
  } finally {
    hidden.remove();
  }
});

Deno.test("cf-map with no bounds opens on its default view, not a bound one", async () => {
  using page = await mounted((map) => {
    map.value = { markers: [{ position: PARIS_CENTER }] };
  });
  const marker = container(page.map).querySelector(".leaflet-marker-icon");
  if (!marker) throw new Error("cf-map drew no marker");
  expect(
    inside(
      marker.getBoundingClientRect(),
      container(page.map).getBoundingClientRect(),
    ),
  ).toBe(false);
});

Deno.test("an animated fit to the features is reported as cf-map's own move", async () => {
  const features: MapValue = {
    markers: [
      { position: { lat: 37.78, lng: -122.42 } },
      { position: { lat: 37.8, lng: -122.4 } },
    ],
  };
  const map = new CFMap();
  map.style.display = "block";
  map.style.width = "400px";
  map.style.height = "300px";
  map.value = features;
  map.fitToBounds = true;
  // Listening before the map renders, since the fit starts as it does.
  const change = nextBoundsChange(map);
  document.body.append(map);
  try {
    expect((await change).userInitiated).toBe(false);
  } finally {
    map.remove();
  }
});

Deno.test("a resize of the container is reported as cf-map's own move", async () => {
  using page = await mounted(() => {});
  const change = nextBoundsChange(page.map);
  page.map.style.width = "200px";
  const detail = await change;
  // The move reported is the resize's: 200 pixels at the default zoom.
  expect(detail.zoom).toBe(13);
  expect(detail.bounds.east - detail.bounds.west).toBeCloseTo(
    lngSpan(200, 13),
    6,
  );
  expect(detail.userInitiated).toBe(false);
});

Deno.test("a wheel zoom is a person's move, and cf-map's next move is not", async () => {
  using page = await mounted((map) => {
    map.bounds = createMockCellHandle(PARIS);
  });
  const box = container(page.map).getBoundingClientRect();
  const zoom = nextBoundsChange(page.map);
  container(page.map).dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: -240,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  expect((await zoom).userInitiated).toBe(true);

  const resize = nextBoundsChange(page.map);
  page.map.style.width = "200px";
  expect((await resize).userInitiated).toBe(false);
});

Deno.test("a drag is a person's move", async () => {
  using page = await mounted(() => {});
  const target = container(page.map);
  const box = target.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const pan = nextBoundsChange(page.map);
  const at = (dx: number) => ({
    clientX: x + dx,
    clientY: y,
    button: 0,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  // A mouse's pointer press; Leaflet drags a mouse on its mouse events.
  target.dispatchEvent(
    new PointerEvent("pointerdown", { ...at(0), pointerType: "mouse" }),
  );
  target.dispatchEvent(new MouseEvent("mousedown", at(0)));
  target.dispatchEvent(new MouseEvent("mousemove", at(40)));
  target.dispatchEvent(new MouseEvent("mousemove", at(80)));
  target.dispatchEvent(new MouseEvent("mouseup", at(80)));
  expect((await pan).userInitiated).toBe(true);
});
