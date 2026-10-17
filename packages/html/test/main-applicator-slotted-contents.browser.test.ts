/**
 * Tests of how `DomApplicator` lays out again a `display: contents` element in
 * a slot after a child is inserted into it somewhere other than at its end.
 *
 * WebKit draws such a child after its later siblings while the document holds
 * it where it was inserted, so a list the reconciler wraps in its array
 * element and a `cf-*` component slots draws out of order. The applicator
 * hides the element and shows it again within the batch, which has WebKit
 * build its boxes anew. deno-web-test runs these in Chromium, which lays the
 * tree out correctly either way, so the repair itself is what they observe —
 * as the two writes it makes to the element's `style` — beside everything the
 * repair must leave as it was. They run under deno-web-test, which registers
 * tests through `Deno.test`.
 */

import { assert, assertEquals } from "@std/assert";

import { DomApplicator } from "../src/main/applicator.ts";
import type { VDomOp } from "../src/vdom-ops.ts";

/** A shadow host that slots its children into a flex column, as `cf-vstack`
 * does. */
class SlottingColumn extends HTMLElement {
  /** Attaches the shadow tree holding the slot. */
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = "<div style='display:flex;flex-direction:column'>" +
      "<slot></slot></div>";
  }
}
customElements.define("x-slotting-column", SlottingColumn);

/** A custom element that counts how often it is disconnected. */
class DisconnectCounter extends HTMLElement {
  /** Disconnections of any instance so far. */
  static disconnected = 0;

  /** Counts a disconnection. */
  disconnectedCallback(): void {
    DisconnectCounter.disconnected++;
  }
}
customElements.define("x-disconnect-counter", DisconnectCounter);

const HOST = 1;
const WRAPPER = 2;

/** A list rendered as the reconciler renders an array: `rows` rows inside a
 * `display: contents` span, inside `hostTag`, and the node ids of the rows. */
function renderList(hostTag: string, rows: number) {
  const container = document.createElement("div");
  document.body.append(container);
  const applicator = new DomApplicator({
    onEvent: () => {},
    onError: (error) => {
      throw error;
    },
  });
  applicator.setContainer(container);
  const ops: VDomOp[] = [
    { op: "create-element", nodeId: HOST, tagName: hostTag },
    { op: "insert-child", parentId: 0, childId: HOST, beforeId: null },
    { op: "create-element", nodeId: WRAPPER, tagName: "span" },
    {
      op: "set-prop",
      nodeId: WRAPPER,
      key: "style",
      value: "display:contents",
    },
    { op: "insert-child", parentId: HOST, childId: WRAPPER, beforeId: null },
  ];
  const rowIds: number[] = [];
  for (let i = 0; i < rows; i++) {
    const id = 10 + i;
    rowIds.push(id);
    ops.push(
      { op: "create-element", nodeId: id, tagName: "div" },
      { op: "set-prop", nodeId: id, key: "id", value: `row-${i}` },
      { op: "insert-child", parentId: WRAPPER, childId: id, beforeId: null },
    );
  }
  applicator.applyBatch({ batchId: 1, ops });
  const wrapper = applicator.getNode(WRAPPER) as HTMLElement;
  return { applicator, container, wrapper, rowIds };
}

/** Records every write to `element`'s `style` attribute while `act` runs. */
function styleWrites(element: HTMLElement, act: () => void): number {
  const observer = new MutationObserver(() => {});
  observer.observe(element, { attributes: true, attributeFilter: ["style"] });
  act();
  const writes = observer.takeRecords().length;
  observer.disconnect();
  return writes;
}

/** The rows' ids in the order they are drawn, top to bottom. */
function drawnOrder(wrapper: HTMLElement): string[] {
  return [...wrapper.children]
    .map((row) => ({ id: row.id, top: row.getBoundingClientRect().top }))
    .sort((a, b) => a.top - b.top)
    .map((row) => row.id);
}

Deno.test("a row moved up in a slotted list lays the list out again", () => {
  const { applicator, container, wrapper, rowIds } = renderList(
    "x-slotting-column",
    5,
  );
  try {
    const writes = styleWrites(wrapper, () =>
      applicator.applyBatch({
        batchId: 2,
        ops: [{
          op: "insert-child",
          parentId: WRAPPER,
          childId: rowIds[4],
          beforeId: rowIds[0],
        }],
      }));
    assertEquals(writes, 2);
    assertEquals(wrapper.getAttribute("style"), "display: contents;");
    assertEquals(
      drawnOrder(wrapper),
      ["row-4", "row-0", "row-1", "row-2", "row-3"],
    );
  } finally {
    container.remove();
  }
});

Deno.test("a new row inserted mid-list in a slotted list lays it out again", () => {
  const { applicator, container, wrapper, rowIds } = renderList(
    "x-slotting-column",
    4,
  );
  try {
    const writes = styleWrites(wrapper, () =>
      applicator.applyBatch({
        batchId: 2,
        ops: [
          { op: "create-element", nodeId: 50, tagName: "div" },
          { op: "set-prop", nodeId: 50, key: "id", value: "row-new" },
          {
            op: "insert-child",
            parentId: WRAPPER,
            childId: 50,
            beforeId: rowIds[2],
          },
          // A second mid-list insert in the same batch is repaired with it.
          {
            op: "insert-child",
            parentId: WRAPPER,
            childId: rowIds[3],
            beforeId: rowIds[0],
          },
        ],
      }));
    assertEquals(writes, 2);
    assertEquals(
      drawnOrder(wrapper),
      ["row-3", "row-0", "row-1", "row-new", "row-2"],
    );
  } finally {
    container.remove();
  }
});

Deno.test("a row appended to a slotted list leaves the list as it is", () => {
  const { applicator, container, wrapper } = renderList(
    "x-slotting-column",
    3,
  );
  try {
    const writes = styleWrites(wrapper, () =>
      applicator.applyBatch({
        batchId: 2,
        ops: [
          { op: "create-element", nodeId: 50, tagName: "div" },
          {
            op: "insert-child",
            parentId: WRAPPER,
            childId: 50,
            beforeId: null,
          },
        ],
      }));
    assertEquals(writes, 0);
  } finally {
    container.remove();
  }
});

Deno.test("a row moved up in a list outside any slot leaves the list as it is", () => {
  const { applicator, container, wrapper, rowIds } = renderList("div", 3);
  try {
    const writes = styleWrites(wrapper, () =>
      applicator.applyBatch({
        batchId: 2,
        ops: [{
          op: "insert-child",
          parentId: WRAPPER,
          childId: rowIds[2],
          beforeId: rowIds[0],
        }],
      }));
    assertEquals(writes, 0);
  } finally {
    container.remove();
  }
});

Deno.test("laying a slotted list out again keeps focus, the caret, scroll offsets and connections", () => {
  const { applicator, container, wrapper, rowIds } = renderList(
    "x-slotting-column",
    3,
  );
  try {
    const row = applicator.getNode(rowIds[1]) as HTMLElement;
    const input = document.createElement("input");
    input.value = "a reply in progress";
    const scroller = document.createElement("div");
    scroller.style.cssText = "height:20px;overflow:auto";
    scroller.innerHTML = "<div style='height:200px'></div>";
    row.append(input, scroller, document.createElement("x-disconnect-counter"));
    scroller.scrollTop = 50;
    input.focus();
    input.setSelectionRange(2, 7);
    const disconnectedBefore = DisconnectCounter.disconnected;

    const writes = styleWrites(wrapper, () =>
      applicator.applyBatch({
        batchId: 2,
        ops: [{
          op: "insert-child",
          parentId: WRAPPER,
          childId: rowIds[2],
          beforeId: rowIds[0],
        }],
      }));

    assertEquals(writes, 2);
    assert(document.activeElement === input, "the input keeps focus");
    assertEquals([input.selectionStart, input.selectionEnd], [2, 7]);
    assertEquals(scroller.scrollTop, 50);
    assertEquals(DisconnectCounter.disconnected, disconnectedBefore);
  } finally {
    container.remove();
  }
});
