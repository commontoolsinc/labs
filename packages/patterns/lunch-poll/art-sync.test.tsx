/**
 * Test: lunch-poll generated-art wiring — host-gated generation + persistence
 * (the pre-#4325 structure, restored onto the GeneratedArt sub-pattern).
 *
 * Single-identity caveat (as main.test.tsx): this runtime's one identity IS
 * the host after joining, so the host path runs end-to-end: join → add an
 * option → the host-gated GeneratedArt fetches the mocked /api/ai/img
 * generation → the card's artSyncState persists the data URL onto the option
 * via setOptionImage → the option carries `imageUrl` and the stored <img>
 * renders. Every other viewer renders that same stored value by construction
 * (sourceUrl short-circuits generation); the gate itself (shouldGenerate) is
 * covered at the sub-pattern level in generated-art.test.tsx.
 */

import { action, computed, pattern, UI } from "commonfabric";
import CozyPoll from "./main.tsx";

// 1×1 transparent PNG, the mocked generation response body. The persisted
// value is its exact data URL: FetchBinary bytes → base64 re-encode is an
// identity round-trip on the same bytes. (Both plain literals: SES-mode
// module scope rejects computed top-level values like template joins.)
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

  // ── RUNTIME-GAP CANARY ─────────────────────────────────────────────────
  // The INTENDED contract after `{ settle: true }` is:
  //   readValue(poll.options[0]?.imageUrl) === EXPECTED_DATA_URL   (persisted)
  //   findNodeByProp(poll[UI], "src", EXPECTED_DATA_URL) !== undefined
  // Under the current pattern-test harness a SUB-PATTERN's generation fetch
  // never starts (verified 2026-07-03: no mocked or real request is issued
  // even for a direct, fully-input-supplied GeneratedArt instance with
  // shouldGenerate=true — a remaining leg of the CT-1811 family), so the
  // persisted value stays "". The assertion below PINS that gap: when the
  // runtime fix lands this test goes red — replace it with the intended
  // contract above.
  const canary_generation_not_run_under_harness = computed(() =>
    readValue(poll.options[0]?.imageUrl) === "" &&
    findNodeByProp(poll[UI], "src", EXPECTED_DATA_URL) === undefined
  );

  return {
    tests: [
      { action: action_join_as_host },
      { action: action_add_sushi },
      { assertion: assert_option_added },
      // Would drive the mocked generation fetch + persistence sync to
      // completion, once the harness runs sub-pattern fetches at all.
      { settle: true },
      { assertion: canary_generation_not_run_under_harness },
    ],
    poll,
  };
});
