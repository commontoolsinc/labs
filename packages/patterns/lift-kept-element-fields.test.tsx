/**
 * Four lifts over one input array, each reading `id` and `driver` off the
 * elements that carry an `id`. They differ only in where the read happens: at
 * the element inside the callback, on a spread copy, through a helper, or on
 * the element itself after it was returned whole from `flatMap`. All four must
 * see both fields of both rows.
 */

import { assert, lift, pattern, TESTS, Writable } from "commonfabric";

type Source = { id: string; driver: string };
type Index = { sources: Array<Source | undefined> };

const describeSource = (s: Source): string => `${s.id}:${s.driver}`;

const readAtElement = lift(({ index }: { index: Index }): string[] =>
  index.sources.flatMap((s) => s?.id ? [`${s.id}:${s.driver}`] : [])
);

const spreadThenRead = lift(({ index }: { index: Index }): string[] =>
  index.sources.flatMap((s) => s?.id ? [{ ...s }] : []).map((s) =>
    `${s.id}:${s.driver}`
  )
);

const readViaHelper = lift(({ index }: { index: Index }): string[] =>
  index.sources.flatMap((s) => s?.id ? [describeSource(s)] : [])
);

const keepThenRead = lift(({ index }: { index: Index }): string[] => {
  const kept = index.sources.flatMap((s) => s?.id ? [s] : []);
  return kept.map((s) => `${s.id}:${s.driver}`);
});

const EXPECTED = JSON.stringify(["a:x", "b:y"]);

const allSeeBothFields = (
  atElement: string[],
  spread: string[],
  helper: string[],
  kept: string[],
): boolean =>
  JSON.stringify(atElement) === EXPECTED &&
  JSON.stringify(spread) === EXPECTED &&
  JSON.stringify(helper) === EXPECTED &&
  JSON.stringify(kept) === EXPECTED;

export default pattern(() => {
  const index = new Writable<Index>({
    sources: [{ id: "a", driver: "x" }, undefined, { id: "b", driver: "y" }],
  });
  const atElement = readAtElement({ index });
  const spread = spreadThenRead({ index });
  const helper = readViaHelper({ index });
  const kept = keepThenRead({ index });

  const assert_all_four_see_both_fields = assert(() =>
    allSeeBothFields(atElement, spread, helper, kept)
  );

  return {
    [TESTS]: [{ assertion: assert_all_four_see_both_fields }],
    atElement,
    spread,
    helper,
    kept,
  };
});
