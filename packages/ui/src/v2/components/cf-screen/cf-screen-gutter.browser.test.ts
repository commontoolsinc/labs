/**
 * Browser tests for the gutter `cf-screen` pads itself by, and for the bars
 * that cancel it. Where content lands is a matter of layout, so each test
 * mounts a screen in a fixed-size box and measures the slotted elements
 * against the screen's edges.
 */

import { expect } from "@std/expect";
import { CFScreen } from "./index.ts";
import "../cf-toolbar/index.ts";
import "../cf-tab-bar/index.ts";

/** A screen mounted in a 400 by 300 box at the viewport's origin. */
type MountedScreen = {
  fixture: HTMLElement;
  screen: CFScreen;
  part: (id: string) => DOMRect;
};

async function mountScreen(
  screenAttributes: string,
  content: string,
  fixtureStyle = "",
): Promise<MountedScreen> {
  const fixture = document.createElement("div");
  fixture.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 400px",
    "height: 300px",
    "margin: 0",
    "padding: 0",
    fixtureStyle,
  ].join(";");
  fixture.innerHTML = `<cf-screen ${screenAttributes}>${content}</cf-screen>`;
  document.body.append(fixture);
  const screen = fixture.querySelector("cf-screen");
  if (!(screen instanceof CFScreen)) throw new Error("no cf-screen mounted");
  const updating = Array.from(fixture.querySelectorAll("*")).flatMap((
    element,
  ) => "updateComplete" in element ? [element.updateComplete] : []);
  await Promise.all(updating);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  return {
    fixture,
    screen,
    part: (id) => {
      const element = fixture.querySelector(`#${id}`);
      if (!element) throw new Error(`no #${id} mounted`);
      return element.getBoundingClientRect();
    },
  };
}

/** Each edge's distance from the screen's matching edge, in pixels. */
function insets(screen: HTMLElement, rect: DOMRect) {
  const outer = screen.getBoundingClientRect();
  return {
    top: rect.top - outer.top,
    left: rect.left - outer.left,
    right: outer.right - rect.right,
    bottom: outer.bottom - rect.bottom,
  };
}

const NAIVE = `
  <div id="header" slot="header" style="height: 20px">Title</div>
  <div id="main" style="height: 40px">Body</div>
  <div id="footer" slot="footer" style="height: 20px">Actions</div>
`;

const BARS = `
  <cf-toolbar id="header" slot="header" style="padding: 7px">Title</cf-toolbar>
  <div id="main" style="height: 40px">Body</div>
  <cf-tab-bar id="footer" slot="footer" variant="inset">
    <cf-tab-bar-item value="home" label="Home"></cf-tab-bar-item>
  </cf-tab-bar>
`;

Deno.test("cf-screen holds naive content in by the theme's loose spacing on every side", async () => {
  const { fixture, screen, part } = await mountScreen(
    "",
    NAIVE,
    "--cf-theme-spacing-loose: 10px",
  );
  try {
    const header = insets(screen, part("header"));
    expect([header.top, header.left, header.right]).toEqual([10, 10, 10]);

    const main = insets(screen, part("main"));
    expect([main.top, main.left, main.right]).toEqual([30, 10, 10]);

    const footer = insets(screen, part("footer"));
    expect([footer.bottom, footer.left, footer.right]).toEqual([10, 10, 10]);
  } finally {
    fixture.remove();
  }
});

Deno.test("cf-screen lets a header toolbar and a footer tab bar run to its edges", async () => {
  const { fixture, screen, part } = await mountScreen(
    "",
    BARS,
    "--cf-theme-spacing-loose: 10px",
  );
  try {
    const header = insets(screen, part("header"));
    expect([header.top, header.left, header.right]).toEqual([0, 0, 0]);

    const footer = insets(screen, part("footer"));
    expect([footer.bottom, footer.left, footer.right]).toEqual([0, 0, 0]);

    const main = insets(screen, part("main"));
    expect([main.left, main.right]).toEqual([10, 10]);
    expect(main.top).toBe(part("header").height);

    const region = (name: string) =>
      screen.shadowRoot?.querySelector(`[part="${name}"]`)
        ?.getBoundingClientRect().height;
    expect(region("header")).toBe(part("header").height);
    expect(region("footer")).toBe(part("footer").height);
  } finally {
    fixture.remove();
  }
});

Deno.test("cf-screen with `bleed` lays its content flush with its edges", async () => {
  const gutter = "--cf-theme-spacing-loose: 10px; --cf-screen-gutter: 24px";
  const inset = await mountScreen("", NAIVE, gutter);
  const { fixture, screen, part } = await mountScreen("bleed", NAIVE, gutter);
  try {
    expect(insets(inset.screen, inset.part("header")).left).toBe(24);

    const header = insets(screen, part("header"));
    expect([header.top, header.left, header.right]).toEqual([0, 0, 0]);

    const main = insets(screen, part("main"));
    expect([main.top, main.left, main.right]).toEqual([20, 0, 0]);

    const footer = insets(screen, part("footer"));
    expect([footer.bottom, footer.left, footer.right]).toEqual([0, 0, 0]);
  } finally {
    inset.fixture.remove();
    fixture.remove();
  }
});

Deno.test("cf-screen takes its gutter from `--cf-screen-gutter` over the theme's spacing", async () => {
  const { fixture, screen, part } = await mountScreen(
    "",
    NAIVE,
    "--cf-theme-spacing-loose: 10px; --cf-screen-gutter: 24px",
  );
  try {
    const header = insets(screen, part("header"));
    expect([header.top, header.left, header.right]).toEqual([24, 24, 24]);

    const main = insets(screen, part("main"));
    expect([main.top, main.left, main.right]).toEqual([44, 24, 24]);

    const footer = insets(screen, part("footer"));
    expect([footer.bottom, footer.left, footer.right]).toEqual([24, 24, 24]);
  } finally {
    fixture.remove();
  }
});
