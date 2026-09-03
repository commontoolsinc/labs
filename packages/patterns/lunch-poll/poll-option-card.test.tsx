import {
  action,
  assert,
  computed,
  handler,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElementByExactText,
  findNodeByProp,
  hasText,
  propsOf,
  propValue,
  readValue,
} from "../test/vnode-helpers.ts";
import PollOptionCard from "./poll-option-card.tsx";
import type {
  CastVoteEvent,
  LogVisitEvent,
  Option,
  OptionTargetEvent,
} from "./main.tsx";

type EmptyState = Record<PropertyKey, never>;

const noopCastVote = handler<CastVoteEvent, EmptyState>(() => {});
const noopLogVisit = handler<LogVisitEvent, EmptyState>(() => {});
const recordOptionTarget = handler<OptionTargetEvent, {
  target: Writable<string | null | undefined>;
}>(({ optionId }, { target }) => target.set(optionId));

// Carries a stored image so this admin-viewer card takes the stored-art path
// (no generation request).
const STORED_OPTION: Option = {
  id: "opt-sushi",
  title: "Sushi Place",
  addedByName: "Alex",
  imageUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
};

// Nothing stored: the admin card can open the shared generated-art editor.
const GENERATING_OPTION: Option = {
  id: "opt-tacos",
  title: "Taco Truck",
  addedByName: "Alex",
  imageUrl: "",
};

export default pattern(() => {
  const removeConfirmTarget = new Writable<string | null | undefined>(
    undefined,
  );
  const artTarget = new Writable<string | null | undefined>(undefined);
  const rank = new Writable<number | undefined>(undefined);
  const reactiveRank = computed(() => rank.get());

  const castVote: Stream<CastVoteEvent> = noopCastVote({});
  const logVisit: Stream<LogVisitEvent> = noopLogVisit({});
  const requestRemove: Stream<OptionTargetEvent> = recordOptionTarget({
    target: removeConfirmTarget,
  });
  const requestArt: Stream<OptionTargetEvent> = recordOptionTarget({
    target: artTarget,
  });

  const card = PollOptionCard({
    option: STORED_OPTION,
    rank: reactiveRank,
    myVote: "green",
    isJoined: true,
    isAdmin: true,
    requestRemove,
    requestArt,
    castVote,
    logVisit,
  });

  const assert_my_green_vote_label_renders = assert(() =>
    findNodeByProp(
      card[UI],
      "aria-label",
      "Clear my green vote",
    ) !== undefined
  );

  const assert_unset_rank_renders_placeholder = assert(() =>
    hasText(card[UI], "—") && !hasText(card[UI], "#0")
  );

  const action_resolve_rank = action(() => rank.set(1));

  const assert_resolved_rank_renders = assert(() =>
    hasText(card[UI], "#1") && !hasText(card[UI], "—")
  );

  const action_set_zero_rank = action(() => rank.set(0));

  const assert_zero_rank_renders_placeholder = assert(() =>
    hasText(card[UI], "—") && !hasText(card[UI], "#0")
  );

  const assert_my_green_vote_styles_buttons = assert(() => {
    const green = findNodeByProp(
      card[UI],
      "aria-label",
      "Clear my green vote",
    );
    const yellow = findNodeByProp(
      card[UI],
      "aria-label",
      "Okay with it",
    );
    const red = findNodeByProp(card[UI], "aria-label", "Veto");
    return typeof propValue(green, "style") === "string" &&
      (propValue(green, "style") as string).includes("#22c55e") &&
      propValue(yellow, "style") === "opacity: 0.4;" &&
      propValue(red, "style") === "opacity: 0.4;";
  });

  const assert_remove_control_contains_only_link_text = assert(() => {
    const remove = findElementByExactText(card[UI], "button", "remove");
    return remove !== undefined &&
      propValue(remove, "aria-label") === "Remove option (host)";
  });

  const assert_remove_control_is_clickable = assert(() => {
    const remove = findElementByExactText(card[UI], "button", "remove");
    return propsOf(remove)?.onClick !== undefined;
  });

  const assert_remove_control_is_underlined = assert(() => {
    const remove = findElementByExactText(card[UI], "button", "remove");
    const removeStyle = propValue(remove, "style");
    return typeof removeStyle === "object" && removeStyle !== null &&
      readValue(
          (removeStyle as Record<PropertyKey, unknown>).textDecoration,
        ) === "underline";
  });

  const assert_remove_separator_is_plain = assert(() => {
    const separator = findElementByExactText(card[UI], "span", "·");
    const separatorAriaHidden = propValue(separator, "aria-hidden");
    const separatorStyle = propValue(separator, "style");
    const separatorStyleRecord =
      typeof separatorStyle === "object" && separatorStyle !== null
        ? separatorStyle as Record<PropertyKey, unknown>
        : undefined;
    const separatorTextDecoration = separatorStyleRecord
      ? readValue(separatorStyleRecord.textDecoration)
      : undefined;
    const separatorTextDecorationLine = separatorStyleRecord
      ? readValue(separatorStyleRecord.textDecorationLine)
      : undefined;
    return separator !== undefined &&
      (separatorAriaHidden === true || separatorAriaHidden === "true") &&
      propsOf(separator)?.onClick === undefined &&
      separatorTextDecoration === "none" &&
      (separatorTextDecorationLine === undefined ||
        separatorTextDecorationLine === "none");
  });

  const assert_log_visit_control_renders = assert(() =>
    findNodeByProp(
      card[UI],
      "aria-label",
      "Log that we went here (host)",
    ) !== undefined
  );

  const assert_stored_image_renders_without_generator = assert(() =>
    findNodeByProp(card[UI], "src", STORED_OPTION.imageUrl) !== undefined &&
    findNodeByProp(
        card[UI],
        "aria-label",
        "Generate art (host)",
      ) === undefined
  );

  // An empty card opens the one parent-owned generator rather than
  // materializing a generator of its own.
  const generatingCard = PollOptionCard({
    option: GENERATING_OPTION,
    rank: 2,
    myVote: undefined,
    isJoined: true,
    isAdmin: true,
    requestRemove,
    requestArt,
    castVote,
    logVisit,
  });

  const assert_generate_button_when_image_missing = assert(() =>
    findNodeByProp(
      generatingCard[UI],
      "aria-label",
      "Generate art (host)",
    ) !== undefined
  );

  const action_open_generated_art = action(() => {
    const button = findNodeByProp(
      generatingCard[UI],
      "aria-label",
      "Generate art (host)",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_generate_targets_option = assert(() =>
    readValue(artTarget) === "opt-tacos"
  );

  return {
    [TESTS]: [
      { assertion: assert_my_green_vote_label_renders },
      { assertion: assert_unset_rank_renders_placeholder },
      { action: action_resolve_rank },
      { assertion: assert_resolved_rank_renders },
      { action: action_set_zero_rank },
      { assertion: assert_zero_rank_renders_placeholder },
      { assertion: assert_my_green_vote_styles_buttons },
      { assertion: assert_remove_control_contains_only_link_text },
      { assertion: assert_remove_control_is_clickable },
      { assertion: assert_remove_control_is_underlined },
      { assertion: assert_remove_separator_is_plain },
      { assertion: assert_log_visit_control_renders },
      { assertion: assert_stored_image_renders_without_generator },
      { assertion: assert_generate_button_when_image_missing },
      { action: action_open_generated_art },
      { assertion: assert_generate_targets_option },
    ],
    card,
    generatingCard,
  };
});
