/**
 * Tests for what a reader actually sees on a mention pill: the short name its
 * destination publishes, rendered beside the label, and still clickable.
 *
 * The name reaches the pill as a `data-short-name` attribute a stylesheet
 * turns into generated content, so none of it is in the document text or in
 * `textContent` — a documented property of the form rather than a gap, which
 * `docs/mention-refs.md` states under the short name — and only a laid-out pill
 * can answer whether it is on screen. That is why these need a browser and run
 * under deno-web-test rather than `deno test`. The harness registers tests through `Deno.test` and calls each
 * one with no arguments, so the BDD functions the rest of the repository uses
 * are not available here.
 *
 * Every case here drives the component's whole path — a destination cell
 * publishing `shortName`, the subscription that reads it, the effect that
 * announces it, the decoration that carries it, and the stylesheet that draws
 * it. Nothing dispatches the effect by hand.
 *
 * One link is outside that: the mock cell network hands back whatever value a
 * handle holds, whatever schema it was read under, so nothing here would
 * notice `MentionableSchema` losing the property. `core/mentionable.test.ts`
 * is what pins that the schema carries it.
 */

import { assert, assertEquals, assertGreater } from "@std/assert";

import { NAME } from "@commonfabric/runner/shared";
import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import type { MentionRefMap } from "../../core/mention-refs.ts";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFCodeEditor } from "./index.ts";

const KEY = "a3f9zz";
const DOCUMENT = `See [Second item][${KEY}] here.`;

interface Mounted {
  element: CFCodeEditor;
  destination: CellHandle<Record<string, unknown>>;
  done(): void;
}

/**
 * An editor holding one mention of a destination that calls itself
 * `shortName`, or that publishes no name at all.
 *
 * Mounted rather than constructed: a pill has no width until it is laid out,
 * and width is what says whether a reader can see the name.
 */
async function mount(shortName?: string): Promise<Mounted> {
  const element = new CFCodeEditor();
  element.value = DOCUMENT;
  element.mode = "prose";
  document.body.appendChild(element);
  await element.updateComplete;
  assert(element.editorView, "the component builds an editor view");

  const destination = destinationNamed(shortName);
  // Bound after the mount, which is also the order a host pattern's cell
  // arrives in: the map announces the key, and the destination's own
  // subscription carries the name.
  await bindReferences(element, destination);

  return { element, destination, done: () => element.remove() };
}

/** A destination piece that calls itself `shortName`, or that names nothing. */
function destinationNamed(
  shortName?: string,
  id = "of:item-42",
): CellHandle<Record<string, unknown>> {
  return createMockCellHandle<Record<string, unknown>>(
    {
      [NAME]: "Second item",
      ...(shortName === undefined ? {} : { shortName }),
    },
    { id } as Partial<CellRef>,
  );
}

/** Point the editor's reference map at `destination`, under the one key. */
async function bindReferences(
  element: CFCodeEditor,
  destination: CellHandle<Record<string, unknown>>,
): Promise<void> {
  element.references = createMockCellHandle({
    [KEY]: { destination, modifiedTitle: false },
  }) as unknown as CellHandle<MentionRefMap>;
  await element.updateComplete;
}

/** The rendered pill the editor draws over the mention's label. */
function pillOf(element: CFCodeEditor): HTMLElement {
  const pill = element.shadowRoot?.querySelector(".cm-mention-ref-pill");
  assert(pill instanceof HTMLElement, "the mention renders as a pill");
  return pill;
}

/** How wide the pill is on screen. */
function pillWidth(element: CFCodeEditor): number {
  return pillOf(element).getBoundingClientRect().width;
}

Deno.test("a pill renders the short name its destination publishes", async () => {
  const named = await mount("42");
  const bare = await mount();
  try {
    assertEquals(pillOf(named.element).getAttribute("data-short-name"), "42");
    // Two pills over the same label in the same document, so the width
    // between them is the number and nothing else. Width is the assertion
    // because the name is generated content: it is in no text node, and a
    // computed `content` may hand back the unresolved `attr()` rather than
    // what it produced.
    assertGreater(pillWidth(named.element), pillWidth(bare.element));
  } finally {
    named.done();
    bare.done();
  }
});

Deno.test("a pill's width follows the short name it was given", async () => {
  const short = await mount("4");
  const long = await mount("4242");
  try {
    // Presence is not enough. A mis-resolved `attr()` would render some fixed
    // glyphs and widen both pills equally, so what is pinned here is that the
    // width tracks the VALUE: same label, same font, longer name, wider pill.
    assertEquals(pillOf(short.element).getAttribute("data-short-name"), "4");
    assertEquals(pillOf(long.element).getAttribute("data-short-name"), "4242");
    assertGreater(pillWidth(long.element), pillWidth(short.element));
  } finally {
    short.done();
    long.done();
  }
});

Deno.test("a pill whose destination publishes no short name renders no marker", async () => {
  const { element, done } = await mount();
  try {
    const pill = pillOf(element);
    assertEquals(pill.hasAttribute("data-short-name"), false);
    // No generated box at all rather than an empty one taking space: the
    // selector is attribute-gated, so a pill without a name gets no `::after`.
    assertEquals(globalThis.getComputedStyle(pill, "::after").content, "none");
  } finally {
    done();
  }
});

Deno.test("clicking the short name navigates to the destination", async () => {
  const { element, destination, done } = await mount("42");
  try {
    const pill = pillOf(element);
    const label = document.createRange();
    label.selectNodeContents(pill);
    // The last pixel of the pill's content, which is the far end of the
    // generated number. Asserting it sits past where the label's own text
    // ends is what makes this a click on the NUMBER: with no number rendered
    // the content would end exactly where the label does, and this point
    // would be the label's own last pixel.
    const box = pill.getBoundingClientRect();
    const padding = parseFloat(globalThis.getComputedStyle(pill).paddingRight);
    const inTheNumber = box.right - padding - 1;
    assertGreater(inTheNumber, label.getBoundingClientRect().right);

    // The handler answers a click on the next turn, so the arrival to wait on
    // is the event it emits rather than any elapsed time.
    const navigated = Promise.withResolvers<CustomEvent>();
    element.addEventListener(
      "backlink-click",
      (event) => navigated.resolve(event as CustomEvent),
      { once: true },
    );
    pill.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: inTheNumber,
        clientY: box.top + box.height / 2,
      }),
    );

    const event = await navigated.promise;
    assertEquals(
      (event.detail.piece as CellHandle<unknown>).id(),
      destination.id(),
    );
  } finally {
    done();
  }
});

Deno.test("a pill drops the short name when its destination is replaced", async () => {
  const { element, done } = await mount("42");
  try {
    assertEquals(pillOf(element).getAttribute("data-short-name"), "42");
    const namedWidth = pillWidth(element);

    // The same key, pointed at a destination that publishes no name. The
    // editor tears the old subscription down before opening the new one, so
    // the number has to go with the destination that published it rather
    // than surviving on a pill that now names something else.
    await bindReferences(element, destinationNamed(undefined, "of:item-none"));

    const pill = pillOf(element);
    assertEquals(pill.hasAttribute("data-short-name"), false);
    assertEquals(globalThis.getComputedStyle(pill, "::after").content, "none");
    assertGreater(namedWidth, pillWidth(element));
  } finally {
    done();
  }
});
