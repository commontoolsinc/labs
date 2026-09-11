import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type {
  Cell,
  CollectionIndexKeyEntry,
  GroupIndex,
  KeyIndex,
} from "@commonfabric/api";

/** Checks lookup cardinality, key domains, and the handle's read-only surface. */
function checkIndexTypes(
  grouped: GroupIndex<string, { name: string }>,
  unique: KeyIndex<Cell<{ name: string }>, { score: number }>,
  profile: Cell<{ name: string }>,
  primitiveCell: Cell<string>,
) {
  const group: { name: string }[] = grouped.lookup("team");
  const emptyGroup: { name: string }[] = grouped.lookup(undefined);
  const match: { score: number } | undefined = unique.lookup(profile);
  const keys: Cell<{ name: string }>[] = unique.keys();
  const tagged: CollectionIndexKeyEntry<Cell<{ name: string }>>[] = unique
    .keyEntries();
  const primitiveEntries: { kind: "value"; value: string }[] = grouped
    .keyEntries();
  const primitiveValue: { name: string }[] = grouped.lookup(
    primitiveCell.get(),
  );
  // @ts-expect-error A Cell argument is an identity key, not its stored string.
  grouped.lookup(primitiveCell);
  // @ts-expect-error String indexes reject numeric keys.
  grouped.lookup(1);
  // @ts-expect-error A Cell-key index rejects a plain object with the same data.
  unique.lookup({ name: "Ada" });
  // @ts-expect-error Index handles do not expose direct stored-value reads.
  grouped.get();
  // @ts-expect-error Index handles do not expose writes.
  unique.set({});
  return {
    group,
    emptyGroup,
    match,
    keys,
    tagged,
    primitiveEntries,
    primitiveValue,
  };
}

describe("collection index types", () => {
  it("checks key domains and missing-result cardinality at compile time", () => {
    expect(typeof checkIndexTypes).toBe("function");
  });
});
