import {
  computed,
  Default,
  handler,
  pattern,
  type Stream,
  UI,
  Writable,
} from "commonfabric";
import PollOptionCard from "./poll-option-card.tsx";
import type {
  CastVoteEvent,
  LogVisitEvent,
  Option,
  RemoveOptionEvent,
  SetOptionImageEvent,
  SetOptionUrlEvent,
  Vote,
} from "./main.tsx";

type EmptyState = Record<PropertyKey, never>;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const readValue = (value: unknown): unknown => {
  if (!isRecord(value) || typeof value.get !== "function") {
    return value;
  }
  return (value.get as () => unknown)();
};

const propsOf = (node: unknown): Record<PropertyKey, unknown> | undefined => {
  const value = readValue(node);
  if (!isRecord(value)) return undefined;
  const props = readValue(value.props);
  return isRecord(props) ? props : undefined;
};

const childrenArray = (children: unknown): unknown[] => {
  const value = readValue(children);
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [value];
};

const childNodes = (node: unknown): unknown[] => {
  const value = readValue(node);
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const ui = value[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...childrenArray(value.children),
  ];
};

const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined => {
  const value = readValue(root);
  const props = propsOf(value);
  if (props && readValue(props[prop]) === expected) return value;
  return childNodes(value)
    .map((child) => findNodeByProp(child, prop, expected))
    .find((child) => child !== undefined);
};

const propValue = (node: unknown, prop: string): unknown => {
  const props = propsOf(node);
  return props ? readValue(props[prop]) : undefined;
};

const noopCastVote = handler<CastVoteEvent, EmptyState>(() => {});
const noopRemoveOption = handler<RemoveOptionEvent, EmptyState>(() => {});
const noopLogVisit = handler<LogVisitEvent, EmptyState>(() => {});
const noopSetOptionUrl = handler<SetOptionUrlEvent, EmptyState>(() => {});
const recordSetOptionImage = handler<SetOptionImageEvent, {
  lastImageUrl: Writable<string>;
}>(({ imageUrl }, { lastImageUrl }) => {
  lastImageUrl.set(imageUrl ?? "");
});

const STORED_OPTION: Option = {
  id: "opt-sushi",
  title: "Sushi Place",
  addedByName: "Alex",
  homePageUrl: "https://sushi.example/menu",
  homePageUrlOverride: "",
  imageUrl: "data:image/png;base64,stored",
};

const votes: Vote[] = [
  {
    optionId: "opt-sushi",
    voterName: "Alex",
    voteType: "green",
  },
];

export default pattern(() => {
  const linkEditTarget = new Writable<string | null>(null);
  const linkDraft = new Writable<string | Default<"">>("");
  const removeConfirmTarget = new Writable<string | null>(null);
  const homePageRefresh = new Writable<number>(0);
  const lastImageUrl = new Writable("");

  const castVote: Stream<CastVoteEvent> = noopCastVote({});
  const removeOption: Stream<RemoveOptionEvent> = noopRemoveOption({});
  const logVisit: Stream<LogVisitEvent> = noopLogVisit({});
  const setOptionUrl: Stream<SetOptionUrlEvent> = noopSetOptionUrl({});
  const setOptionHomePageUrl: Stream<SetOptionUrlEvent> = noopSetOptionUrl({});
  const setOptionImage: Stream<SetOptionImageEvent> = recordSetOptionImage({
    lastImageUrl,
  });

  const card = PollOptionCard({
    option: STORED_OPTION,
    rank: 1,
    me: "Alex",
    isJoined: true,
    isAdmin: true,
    votes,
    cityLabel: "Berkeley, CA",
    searchEndpoint: "",
    homePageRefresh,
    linkEditTarget,
    linkDraft,
    removeConfirmTarget,
    castVote,
    removeOption,
    logVisit,
    setOptionUrl,
    setOptionHomePageUrl,
    setOptionImage,
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

  const assert_host_homepage_link_renders = computed(() =>
    findNodeByProp(
      card[UI],
      "href",
      "https://sushi.example/menu",
    ) !== undefined
  );

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

  const assert_stored_art_renders = computed(() =>
    findNodeByProp(
      card[UI],
      "src",
      STORED_OPTION.imageUrl,
    ) !== undefined
  );

  const assert_host_did_not_rewrite_stored_art = computed(() =>
    lastImageUrl.get() === ""
  );

  return {
    tests: [
      { assertion: assert_my_green_vote_label_renders },
      { assertion: assert_my_green_vote_styles_buttons },
      { assertion: assert_host_homepage_link_renders },
      { assertion: assert_host_controls_render },
      { assertion: assert_stored_art_renders },
      { assertion: assert_host_did_not_rewrite_stored_art },
    ],
    card,
  };
});
