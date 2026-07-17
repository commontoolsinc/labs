/**
 * Test: the "Update All Values" button drives every reactive value.
 *
 * The demo binds updateAllValues to a button rather than exporting it, so the
 * test reaches the handler the way the runtime does: walk the rendered tree to
 * the button and send an event to the stream bound to its onClick.
 *
 * Run: deno task cf test packages/patterns/gideon-tests/test-reactivity-jsx-automatic.test.tsx --root packages/patterns --verbose
 */
import { action, computed, pattern, UI } from "commonfabric";
import {
  findElementByText,
  propsOf,
  textContent,
} from "../test/vnode-helpers.ts";
import JsxAutomaticReactivity from "./test-reactivity-jsx-automatic.tsx";

export default pattern(() => {
  const subject = JsxAutomaticReactivity({
    count: 0,
    user: { name: "Alice", age: 30 },
    items: [{ title: "Item 1" }, { title: "Item 2" }, { title: "Item 3" }],
  });

  const action_click_update = action(() => {
    const button = findElementByText(subject[UI], "cf-button", "Update All");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_initial_count = computed(() => subject.count === 0);
  const assert_initial_user = computed(() => subject.user.name === "Alice");
  const assert_initial_items = computed(() => [...subject.items].length === 3);

  // The pattern's claim is that an expression in JSX tracks its inputs with no
  // computed() wrapper, so read it from the rendered tree rather than from the
  // output.
  const assert_initial_inline_expression = computed(() =>
    textContent(findElementByText(subject[UI], "div", "Count x 2 ="))
      .includes("Count x 2 = 0")
  );

  const assert_count_after_first = computed(() => subject.count === 1);
  const assert_user_after_first = computed(() => subject.user.name === "Bob");
  const assert_inline_expression_after_first = computed(() =>
    textContent(findElementByText(subject[UI], "div", "Count x 2 ="))
      .includes("Count x 2 = 2")
  );

  // The append derives the new title from the same snapshot the length guard
  // read, so the fourth item is titled from a length of 3.
  const assert_items_after_first = computed(() => {
    const items = [...subject.items];
    return items.length === 4 && items[3].title === "Item 4";
  });

  // Each further click appends one item, titled from the growing snapshot,
  // until the guard stops the append at five.
  const assert_items_after_second = computed(() => {
    const items = [...subject.items];
    return items.length === 5 && items[4].title === "Item 5";
  });
  const assert_user_after_second = computed(() =>
    subject.user.name === "Alice"
  );

  // At five entries the guard takes the other branch and truncates to three.
  const assert_items_after_third = computed(() => {
    const items = [...subject.items];
    return items.length === 3 && items[2].title === "Item 3";
  });
  const assert_count_after_third = computed(() => subject.count === 3);

  return {
    tests: [
      { assertion: assert_initial_count },
      { assertion: assert_initial_user },
      { assertion: assert_initial_items },
      { assertion: assert_initial_inline_expression },

      { action: action_click_update },
      { assertion: assert_count_after_first },
      { assertion: assert_user_after_first },
      { assertion: assert_items_after_first },
      { assertion: assert_inline_expression_after_first },

      { action: action_click_update },
      { assertion: assert_items_after_second },
      { assertion: assert_user_after_second },

      { action: action_click_update },
      { assertion: assert_items_after_third },
      { assertion: assert_count_after_third },
    ],
    subject,
  };
});
