import { assert, assertAlmostEquals } from "@std/assert";

import type { DID } from "@commonfabric/identity";

import { type CFPieceMenu, openPieceMenu } from "./index.ts";

// A real space identifier, long enough that the heading naming it wraps onto a
// second line. The menu's height follows from what it holds.
const SPACE = "did:key:z6MkjfXbUdrKdCPvCXPYJDnKNDVqUvUj9tQ4wJUtLZ6hEGRj" as DID;

/** The margin the menu keeps from an edge it was pulled back from. */
const MARGIN = 4;

/** Open the menu at a click position and measure where it came to rest. */
async function openAt(
  x: number,
  y: number,
): Promise<{ menu: CFPieceMenu; box: DOMRect; text: string }> {
  const menu = openPieceMenu({ space: SPACE, x, y });
  await (menu as unknown as { updateComplete: Promise<unknown> })
    .updateComplete;
  const element = menu.shadowRoot?.querySelector(".menu");
  assert(element instanceof HTMLElement, "the menu should be rendered");
  return {
    menu,
    box: element.getBoundingClientRect(),
    text: element.innerText,
  };
}

Deno.test("the menu opens at the click when it fits there", async () => {
  const { menu, box, text } = await openAt(40, 40);
  try {
    assert(text.includes(SPACE), `the menu should name ${SPACE}`);
    assert(box.height > 0, "the menu should have a box");
    assertAlmostEquals(box.left, 40, 0.5);
    assertAlmostEquals(box.top, 40, 0.5);
  } finally {
    menu.close();
  }
});

Deno.test("a corner click pulls the whole menu back into view", async () => {
  // The menu is placed from its own measured box, so a corner click brings its
  // far edges to rest exactly on the margin whatever size its content gives
  // it.

  const { menu, box } = await openAt(innerWidth - MARGIN, innerHeight - MARGIN);
  try {
    assert(
      box.width > 0 && box.width < innerWidth - 2 * MARGIN &&
        box.height > 0 && box.height < innerHeight - 2 * MARGIN,
      `a ${box.width} by ${box.height} menu needs a roomier viewport than ` +
        `${innerWidth} by ${innerHeight}`,
    );
    assertAlmostEquals(box.right, innerWidth - MARGIN, 0.5);
    assertAlmostEquals(box.bottom, innerHeight - MARGIN, 0.5);
  } finally {
    menu.close();
  }
});
