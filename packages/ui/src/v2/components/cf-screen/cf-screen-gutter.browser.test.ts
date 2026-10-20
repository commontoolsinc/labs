/**
 * Browser tests for the gutter `cf-screen` holds its content in by. Where the
 * content lands is a matter of layout, so each test mounts a screen in a
 * fixed-size box and measures the slotted elements against the screen's edges.
 */

import { expect } from "@std/expect";
import { CFScreen } from "./index.ts";

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
  await screen.updateComplete;
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

const HEADER_MAIN_FOOTER = `
  <div id="header" slot="header" style="height: 20px">Title</div>
  <div id="main" style="height: 40px">Body</div>
  <div id="footer" slot="footer" style="height: 20px">Actions</div>
`;

Deno.test("cf-screen holds its header, main and footer in by the theme's loose spacing", async () => {
  const { fixture, screen, part } = await mountScreen(
    "",
    HEADER_MAIN_FOOTER,
    "--cf-theme-spacing-loose: 10px",
  );
  try {
    const header = insets(screen, part("header"));
    expect([header.top, header.left, header.right]).toEqual([10, 10, 10]);

    const main = insets(screen, part("main"));
    expect(main.top).toBe(header.top + 20 + 10);
    expect([main.left, main.right]).toEqual([10, 10]);

    const footer = insets(screen, part("footer"));
    expect([footer.bottom, footer.left, footer.right]).toEqual([10, 10, 10]);
  } finally {
    fixture.remove();
  }
});

Deno.test("cf-screen adds no gutter for a header or footer it does not have", async () => {
  const { fixture, screen, part } = await mountScreen(
    "",
    `<div id="main" style="flex: 1">Body</div>`,
    "--cf-theme-spacing-loose: 10px",
  );
  try {
    const main = insets(screen, part("main"));
    expect(main).toEqual({ top: 10, left: 10, right: 10, bottom: 10 });
  } finally {
    fixture.remove();
  }
});

Deno.test("cf-screen with `bleed` lays every region flush with its edges", async () => {
  const gutter = "--cf-theme-spacing-loose: 10px; --cf-screen-gutter: 24px";
  const inset = await mountScreen("", HEADER_MAIN_FOOTER, gutter);
  const { fixture, screen, part } = await mountScreen(
    "bleed",
    HEADER_MAIN_FOOTER,
    gutter,
  );
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
    HEADER_MAIN_FOOTER,
    "--cf-theme-spacing-loose: 10px; --cf-screen-gutter: 24px",
  );
  try {
    const header = insets(screen, part("header"));
    expect([header.top, header.left, header.right]).toEqual([24, 24, 24]);

    const main = insets(screen, part("main"));
    expect(main.top).toBe(24 + 20 + 24);
    expect([main.left, main.right]).toEqual([24, 24]);

    const footer = insets(screen, part("footer"));
    expect([footer.bottom, footer.left, footer.right]).toEqual([24, 24, 24]);
  } finally {
    fixture.remove();
  }
});
