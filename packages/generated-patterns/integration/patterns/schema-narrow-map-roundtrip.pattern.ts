import { cell, Default, lift, pattern } from "commonfabric";

// Minimal reproduction of the usage-based schema-narrowing bug also seen in
// library-checkout-system. A lift reads one field of an input-array element
// DIRECTLY (so capability analysis tracks it) and another field ONLY after
// the element has round-tripped through a local `Map` (which the analysis
// can't trace). The untracked field is pruned from the lift's INPUT schema,
// so it arrives `undefined` and the output is computed from a partial record.

interface Entry {
  key: string;
  value: string;
}

const defaultEntries: Entry[] = [
  { key: "a", value: "alpha" },
  { key: "b", value: "beta" },
];

// `entry.key` is read directly in the grouping loop -> tracked -> kept.
// `entry.value` is read only via `byKey.get(...)` -> untracked -> pruned from
// the emitted input schema's Entry definition (loses `value`).
const liftValuesViaMap = lift((input: { entries: Entry[] }) => {
  const byKey = new Map<string, Entry[]>();
  for (const entry of input.entries) {
    const bucket = byKey.get(entry.key) ?? [];
    bucket.push(entry);
    byKey.set(entry.key, bucket);
  }
  return ["a", "b"].map((k) =>
    (byKey.get(k) ?? []).map((entry) => entry.value)
  );
});

// Control: identical reads, but the field is read DIRECTLY off the element,
// so it stays in the schema and the output is correct.
const liftValuesDirect = lift((input: { entries: Entry[] }) =>
  input.entries.map((entry) => entry.value)
);

interface SchemaNarrowArgs {
  entries: Default<Entry[], typeof defaultEntries>;
}

export const schemaNarrowMapRoundtrip = pattern<SchemaNarrowArgs>(
  ({ entries }) => {
    const entryState = cell<Entry[]>(
      defaultEntries.map((entry) => ({ ...entry })),
    );
    return {
      entries,
      entryState,
      valuesViaMap: liftValuesViaMap({ entries: entryState }),
      valuesDirect: liftValuesDirect({ entries: entryState }),
    };
  },
);

export default schemaNarrowMapRoundtrip;
