/**
 * Test: lunch-poll generated-art wiring — host-gated generation + AUTOMATIC
 * persistence. The card renders a hidden trigger img over the freshly
 * generated data URL; the browser's `load` event sends the admin-gated,
 * idempotent `setOptionImage` handler (the same sanctioned persistence path
 * the old manual keep button used, minus the click). A stream send is the
 * one mutation that works from inside the card: map-instantiated children
 * are minted at user scope, so direct writes through input handles land in
 * a `user:<did>` instance no other viewer reads, while sends resolve
 * value-mode to the real space-bound handler.
 *
 * Single-identity caveat (as main.test.tsx): this runtime's one identity IS
 * the host after joining, so the host path runs end-to-end: join → add an
 * option → the host-gated GeneratedArt fetches the mocked /api/ai/img
 * generation → the trigger img renders (this VNode harness has no real DOM,
 * so the test fires its `load` by sending into the trigger's onLoad stream —
 * the browser event and this send reach the identical lowered handler, which
 * closes over the card's own state) → the option carries `imageUrl` and the
 * stored <img> renders. Every other viewer renders that same stored value by
 * construction (sourceUrl short-circuits generation); cross-runtime
 * visibility is covered by multi-user-art.test.tsx and the gate itself
 * (shouldGenerate) at the sub-pattern level in generated-art.test.tsx.
 */

import { action, assert, computed, pattern, UI } from "commonfabric";
import CozyPoll from "./main.tsx";

// 1×1 transparent PNG, the mocked generation response body. The persisted
// value is its exact data URL: FetchBinary bytes → base64 re-encode is an
// identity round-trip on the same bytes, so the trigger handler and this
// test compare the same string. (Both plain literals: SES-mode module scope
// rejects computed top-level values like template joins.)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const EXPECTED_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const fetchMocks = [
  {
    urlIncludes: "/api/ai/img",
    contentType: "image/png",
    base64Body: TINY_PNG_BASE64,
  },
];

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

// The hidden auto-persist trigger img for the option with the given id
// (module scope: SES callbacks must not capture pattern-body callables).
const findTriggerIn = (root: unknown, optionId: unknown): unknown =>
  findNodeByProp(root, "data-art-persist-trigger", optionId);

export default pattern(() => {
  const poll = CozyPoll({});

  const action_join_as_host = action(() => {
    poll.joinAs.send({ name: "Host" });
  });

  const action_add_sushi = action(() => {
    poll.addOption.send({ title: "Sushi Palace" });
  });

  const assert_option_added = computed(() =>
    poll.options.length === 1 && poll.options[0]?.title === "Sushi Palace"
  );

  // Post-settle the host's client has generated: the hidden auto-persist
  // trigger img is in the rendered tree, carrying the generated data URL and
  // a wired onLoad handler (the fetch-derived read chain through both
  // sub-pattern boundaries works — until CT-1836's traversal fix this file
  // carried a canary pinning the opposite).
  const assert_trigger_renders = assert(() => {
    const trigger = findTriggerIn(poll[UI], readValue(poll.options[0]?.id));
    return trigger !== undefined &&
      readValue(propsOf(trigger)?.src) === EXPECTED_DATA_URL &&
      propsOf(trigger)?.onLoad !== undefined;
  });

  // Fire the trigger's `load` (no real DOM here — send into its onLoad
  // stream; the handler closes over the card's state and builds the real
  // payload itself).
  const action_fire_trigger_load = action(() => {
    const trigger = findTriggerIn(poll[UI], readValue(poll.options[0]?.id));
    const onLoad = propsOf(trigger)?.onLoad;
    if (typeof onLoad === "object" && onLoad !== null && "send" in onLoad) {
      (onLoad as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_image_persisted = assert(() =>
    readValue(poll.options[0]?.imageUrl) === EXPECTED_DATA_URL
  );

  const assert_stored_img_renders = assert(() =>
    findNodeByProp(poll[UI], "src", EXPECTED_DATA_URL) !== undefined &&
    findTriggerIn(poll[UI], readValue(poll.options[0]?.id)) === undefined
  );

  return {
    tests: [
      { action: action_join_as_host },
      { action: action_add_sushi },
      { assertion: assert_option_added },
      // Drives the mocked generation fetch to completion.
      { settle: true },
      { assertion: assert_trigger_renders },
      { action: action_fire_trigger_load },
      { assertion: assert_image_persisted },
      // One more settle beat: the persisted URL flows back into the card as
      // `sourceUrl`, the stored-<img> branch renders, and the trigger
      // unmounts.
      { settle: true },
      { assertion: assert_stored_img_renders },
    ],
    poll,
  };
});
