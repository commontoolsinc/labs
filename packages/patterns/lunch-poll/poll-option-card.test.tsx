import {
  computed,
  handler,
  pattern,
  type Stream,
  UI,
  Writable,
} from "commonfabric";
import { findNode, propsOf, readValue } from "../test/vnode-helpers.ts";
import PollOptionCard from "./poll-option-card.tsx";
import type {
  CastVoteEvent,
  LogVisitEvent,
  Option,
  RemoveOptionEvent,
  Vote,
} from "./main.tsx";

type EmptyState = Record<PropertyKey, never>;

const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined =>
  findNode(root, (node) => {
    const props = propsOf(node);
    return props !== undefined && readValue(props[prop]) === expected;
  });

const propValue = (node: unknown, prop: string): unknown => {
  const props = propsOf(node);
  return props ? readValue(props[prop]) : undefined;
};

const noopCastVote = handler<CastVoteEvent, EmptyState>(() => {});
const noopRemoveOption = handler<RemoveOptionEvent, EmptyState>(() => {});
const noopLogVisit = handler<LogVisitEvent, EmptyState>(() => {});

const STORED_OPTION: Option = {
  id: "opt-sushi",
  title: "Sushi Place",
  addedByName: "Alex",
};

const votes: Vote[] = [
  {
    optionId: "opt-sushi",
    voterName: "Alex",
    voteType: "green",
  },
];

export default pattern(() => {
  const removeConfirmTarget = new Writable<string | null>(null);

  const castVote: Stream<CastVoteEvent> = noopCastVote({});
  const removeOption: Stream<RemoveOptionEvent> = noopRemoveOption({});
  const logVisit: Stream<LogVisitEvent> = noopLogVisit({});

  const card = PollOptionCard({
    option: STORED_OPTION,
    rank: 1,
    me: "Alex",
    isJoined: true,
    isAdmin: true,
    votes,
    removeConfirmTarget,
    castVote,
    removeOption,
    logVisit,
  });

  const assert_my_green_vote_label_renders = computed(() =>
    findNodeByProp(
      card[UI],
      "aria-label",
      "Clear my green vote",
    ) !== undefined
  );

  const assert_my_green_vote_styles_buttons = computed(() => {
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

  const assert_host_controls_render = computed(() => {
    const remove = findNodeByProp(
      card[UI],
      "aria-label",
      "Remove option (host)",
    );
    const logVisit = findNodeByProp(
      card[UI],
      "aria-label",
      "Log that we went here (host)",
    );
    return remove !== undefined && logVisit !== undefined;
  });

  return {
    tests: [
      { assertion: assert_my_green_vote_label_renders },
      { assertion: assert_my_green_vote_styles_buttons },
      { assertion: assert_host_controls_render },
    ],
    card,
  };
});
