/**
 * Verifies that a large lunch poll materializes one bounded option page while
 * every stored option remains reachable through the paging controls.
 */

import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findElementByExactText,
  findNodeByProp,
  hasText,
  propsOf,
} from "../test/vnode-helpers.ts";
import CozyPoll, { type Option } from "./main.tsx";

const OPTIONS: Option[] = [
  { id: "option-1", title: "Restaurant 1", addedByName: "Host" },
  { id: "option-2", title: "Restaurant 2", addedByName: "Host" },
  { id: "option-3", title: "Restaurant 3", addedByName: "Host" },
  { id: "option-4", title: "Restaurant 4", addedByName: "Host" },
  { id: "option-5", title: "Restaurant 5", addedByName: "Host" },
  { id: "option-6", title: "Restaurant 6", addedByName: "Host" },
  { id: "option-7", title: "Restaurant 7", addedByName: "Host" },
  { id: "option-8", title: "Restaurant 8", addedByName: "Host" },
  { id: "option-9", title: "Restaurant 9", addedByName: "Host" },
  { id: "option-10", title: "Restaurant 10", addedByName: "Host" },
  { id: "option-11", title: "Restaurant 11", addedByName: "Host" },
  { id: "option-12", title: "Restaurant 12", addedByName: "Host" },
  { id: "option-13", title: "Restaurant 13", addedByName: "Host" },
  { id: "option-14", title: "Restaurant 14", addedByName: "Host" },
  { id: "option-15", title: "Restaurant 15", addedByName: "Host" },
];

export default pattern(() => {
  const options = Writable.of<Option[]>(OPTIONS);
  const poll = CozyPoll({ options });

  const assert_first_page_is_bounded = assert(() =>
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 1") !==
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 7") !==
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 8") ===
      undefined &&
    hasText(poll[UI], "Options 1–7 of 15 · shared view")
  );

  const action_next_page = action(() => {
    const button = findElementByExactText(poll[UI], "cf-button", "Next");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_second_page_is_reachable = assert(() =>
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 1") ===
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 8") !==
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 14") !==
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 15") ===
      undefined &&
    hasText(poll[UI], "Options 8–14 of 15 · shared view")
  );

  const assert_third_page_is_reachable = assert(() =>
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 14") ===
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 15") !==
      undefined &&
    hasText(poll[UI], "Options 15–15 of 15 · shared view")
  );

  const action_remove_last_page = action(() => {
    options.set(OPTIONS.slice(0, 8));
  });

  const assert_removed_page_clamps_to_last_page = assert(() =>
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 8") !==
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 15") ===
      undefined &&
    hasText(poll[UI], "Options 8–8 of 8 · shared view")
  );

  const assert_first_page_after_removal = assert(() =>
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 1") !==
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 7") !==
      undefined &&
    findNodeByProp(poll[UI], "data-option-title", "Restaurant 8") ===
      undefined &&
    hasText(poll[UI], "Options 1–7 of 8 · shared view")
  );

  const action_previous_page = action(() => {
    const button = findElementByExactText(poll[UI], "cf-button", "Previous");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  return {
    [TESTS]: [
      { assertion: assert_first_page_is_bounded },
      { action: action_next_page },
      { assertion: assert_second_page_is_reachable },
      { action: action_next_page },
      { assertion: assert_third_page_is_reachable },
      { action: action_remove_last_page },
      { assertion: assert_removed_page_clamps_to_last_page },
      { action: action_previous_page },
      { assertion: assert_first_page_after_removal },
    ],
    poll,
  };
});
