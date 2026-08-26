/**
 * What the board and a topic actually RENDER through whatever projection the
 * board declares for its topics: that a card carries its topic's text, and
 * that the body editor's completion source reaches it populated.
 *
 * Both assertions were validated by mutation — remove the step that files a
 * topic and both go red — so neither is decoration.
 *
 * WHAT THIS CANNOT CATCH, stated because the gap is not obvious and I walked
 * into it: narrowing `mentionable` to a projection WITHOUT `[NAME]` leaves
 * both assertions green. `cf-code-editor` declares its entries as
 * `Mentionable`, whose schema carries `required: [NAME]`
 * (`packages/ui/src/v2/core/mentionable.ts`), but that filtering happens at
 * the COMPONENT's read in the browser. A pattern test sees the cell, not the
 * component's schema-filtered view of it, so the entries still carry their
 * name here however narrowly the pattern declared them. Only a browser test
 * crosses that boundary; `packages/patterns/integration/topic-board-*` is
 * where that guard belongs.
 *
 * Deliberately separate from topics.test.tsx: it touches no verb through the
 * board's projection, so it keeps compiling while a demand-narrowing change is
 * in flight — which is exactly when the render contract needs guarding.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import Topics from "./main.tsx";
import Topic from "./topic.tsx";

interface TestVNode {
  type: "vnode";
  name: string;
  // deno-lint-ignore no-explicit-any
  props: Record<string, any>;
  children: unknown[];
}

const isVNode = (node: unknown): node is TestVNode =>
  typeof node === "object" && node !== null &&
  (node as { type?: unknown }).type === "vnode";

function findAllByTag(
  node: unknown,
  tag: string,
  found: TestVNode[] = [],
): TestVNode[] {
  // Resolved BEFORE either test, and before the array check so that a
  // cell-backed list of children is stepped through rather than skipped. A
  // compiled reactive child arrives cell-backed, and asking `isVNode` of the
  // cell rather than its value stops the walk one level above whatever it was
  // looking for. That failure is not silent here — the assertions below treat
  // "no editor found" as false — but a guard that reports a real render as a
  // regression is no more use than one that misses it. `propValue` returns a
  // non-cell unchanged, so this costs nothing on the plain path.
  const resolved = propValue(node);
  if (Array.isArray(resolved)) {
    resolved.forEach((child) => findAllByTag(child, tag, found));
    return found;
  }
  if (!isVNode(resolved)) return found;
  if (resolved.name === tag) found.push(resolved);
  for (const child of resolved.children ?? []) findAllByTag(child, tag, found);
  return found;
}

/** Compiled JSX props can be cell-backed even where the source wrote a plain
 * value, so every prop read goes through this. */
// deno-lint-ignore no-explicit-any
const propValue = (value: any): unknown =>
  value && typeof value.get === "function" ? value.get() : value;

/** Every string anywhere in a rendered subtree, so an assertion can ask what
 * the reader would SEE rather than what the model holds. */
function renderedText(node: unknown, into: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => renderedText(child, into));
    return into;
  }
  const resolved = propValue(node);
  if (typeof resolved === "string") {
    into.push(resolved);
    return into;
  }
  if (!isVNode(resolved)) return into;
  for (const child of resolved.children ?? []) renderedText(child, into);
  return into;
}

export default pattern(() => {
  const board = Topics({});

  const action_file_a_topic = action(() => {
    board.addTopic.send({
      title: "Rendered topic",
      body: "the living document",
      agentName: "Fable",
    });
  });

  // Wired the way `addTopic` wires its own children, so the projection under
  // test is the one production uses rather than a fixture's.
  const detail = Topic({
    title: "Detail topic",
    mentionable: board.mentionable,
    boardCrossrefs: board.crossrefs,
  });

  const action_open_the_editor = action(() => {
    detail.startEditBody.send();
  });

  // The board's card list renders through whatever the board demands of a
  // stored topic. If that projection stops carrying a field a card reads, the
  // card goes blank while every model-level assertion stays green.
  const assert_card_shows_its_topic = assert(() => {
    const text = renderedText(board[UI]).join(" ");
    return text.includes("Rendered topic") &&
      text.includes("the living document");
  });

  // The break this file exists for: the editor's completion source must reach
  // it non-empty, and each entry must carry the display name the component
  // declares as required.
  const assert_editor_receives_mentionables = assert(() => {
    const editors = findAllByTag(detail[UI], "cf-code-editor");
    if (editors.length !== 1) return false;
    const entries = propValue(editors[0].props["$mentionable"]);
    if (!Array.isArray(entries) || entries.length === 0) return false;
    return entries.every((entry) => {
      const name = propValue((entry as Record<string, unknown>)?.[NAME]);
      return typeof name === "string" && name.length > 0;
    });
  });

  return {
    [UI]: board[UI],
    [TESTS]: [
      { action: action_file_a_topic },
      { render: board[UI] },
      { assertion: assert_card_shows_its_topic },
      { action: action_open_the_editor },
      { render: detail[UI] },
      { assertion: assert_editor_receives_mentionables },
    ],
  };
});
