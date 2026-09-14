import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";

import { collectConsumedLabel } from "../../src/cfc/prepare.ts";
import { describeRefusalInputs } from "../../src/cfc/refusal-detail.ts";
import type {
  CfcAddress,
  CfcLabelMetadataObservation,
} from "../../src/cfc/types.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
} from "../../src/storage/interface.ts";

const address: CfcAddress = {
  space: "did:key:source",
  id: "of:source",
  scope: "space",
  path: ["field"],
};

/** Supplies the collector's read surfaces without preprocessing their identity. */
function transaction(
  observations: readonly CfcLabelMetadataObservation[] = [],
  reads: readonly IReadActivity[] = [],
  entries: FabricValue = [],
): IExtendedStorageTransaction {
  const state = {
    triggerReadGating: false,
    labelMetadataObservations: [...observations],
  } satisfies Partial<ReturnType<IExtendedStorageTransaction["getCfcState"]>>;
  const surfaces: Partial<IExtendedStorageTransaction> = {
    getCfcState: () =>
      state as ReturnType<IExtendedStorageTransaction["getCfcState"]>,
    getReadActivities: () => reads,
    readOrThrow: () => ({
      version: 1,
      schemaHash: "test-schema",
      labelMap: { version: 1, entries },
    }),
  };
  return surfaces as IExtendedStorageTransaction;
}

/** One metadata observation contributing the supplied clauses at an address. */
function observation(
  target: CfcAddress,
  confidentiality: CfcLabelMetadataObservation["confidentiality"],
): CfcLabelMetadataObservation {
  return { target, observes: "labelMetadata", confidentiality };
}

describe("collectConsumedLabel()", () => {
  it("keeps structurally distinct clauses and their first source in encounter order", () => {
    const first = { a: 1, b: 2 };
    const second = { a: 2, b: 1 };
    const sources = collectConsumedLabel(transaction([
      observation(address, [first, second, { b: 2, a: 1 }, -0, 0, -0]),
      observation({ ...address }, [{ b: 1, a: 2 }]),
    ])).sources;

    expect(sources).toHaveLength(4);
    expect(sources[0].atom).toBe(first);
    expect(sources[1].atom).toBe(second);
    expect(sources[2].atom).toBe(-0);
    expect(sources[3].atom).toBe(0);
    expect(sources[0].read).toBe(address);
  });

  it("distinguishes every address field and preserves escaped path segments", () => {
    const addresses: CfcAddress[] = [
      address,
      { ...address, id: "of:other" },
      { ...address, space: "did:key:other" },
      { ...address, scope: "user" },
      { ...address, id: "of:source\0did:key:extra" },
      { ...address, space: "did:key:extra\0did:key:source" },
      ...[[], [""], ["a/b"], ["a", "b"], ["~1"], ["/"]].map((path) => ({
        ...address,
        path,
      })),
      { ...address, path: ["a\0/b"], id: "of:source\0extra" },
      { ...address, path: ["extra\0/a\0/b"] },
    ];
    const sources = collectConsumedLabel(transaction(
      [...addresses, ...addresses].map((target) =>
        observation(target, ["private"])
      ),
    )).sources;

    expect(sources.map((source) => source.read)).toEqual(addresses);
    const detail = describeRefusalInputs(["private"], sources);
    expect(detail.attribution).toBe("complete");
    expect(detail.inputs.map((input) => input.read)).toEqual(addresses);
  });

  it("preserves encounter order when clauses from different addresses interleave", () => {
    const other = { ...address, id: "of:other" };
    const sources = collectConsumedLabel(transaction([
      observation(address, ["first"]),
      observation(other, ["first"]),
      observation(address, ["second"]),
      observation(other, ["first"]),
      observation(address, ["second", "first"]),
    ])).sources;

    expect(sources).toEqual([
      { atom: "first", read: address, labelPath: address.path },
      { atom: "first", read: other, labelPath: other.path },
      { atom: "second", read: address, labelPath: address.path },
    ]);
  });

  it("deduplicates canonical path aliases while retaining the first address", () => {
    const first = { ...address, path: ["value", "field"] };
    const sources = collectConsumedLabel(transaction([
      observation(first, ["private"]),
      observation(address, ["private"]),
    ])).sources;

    expect(sources).toHaveLength(1);
    expect(sources[0].read).toBe(first);
  });

  it("keeps distinct label paths for one read and joins payload and metadata sources", () => {
    const read: IReadActivity = {
      ...address,
      id: "of:source",
      path: ["value", "field"],
      meta: {},
    };
    const result = collectConsumedLabel(transaction(
      [
        observation(address, ["private"]),
      ],
      [read, read],
      [
        {
          path: [],
          label: { confidentiality: ["private"], integrity: ["guard"] },
        },
        { path: ["field"], label: { confidentiality: ["private"] } },
        { path: ["value", "field"], label: { confidentiality: ["private"] } },
      ],
    ));

    expect(result.sources).toEqual([
      { atom: "private", read: address, labelPath: [] },
      { atom: "private", read: address, labelPath: ["field"] },
    ]);
    expect(result.confidentiality).toEqual(["private"]);
    expect(result.integrity).toEqual(["guard"]);
    expect(result.modulePolicySpaces.size).toBe(0);
  });

  it("starts a fresh source set for each collection", () => {
    const tx = transaction([observation(address, ["private"])]);
    const first = collectConsumedLabel(tx);
    const second = collectConsumedLabel(tx);

    expect(first.sources).toHaveLength(1);
    expect(second.sources).toEqual(first.sources);
    expect(second.sources).not.toBe(first.sources);
    expect(collectConsumedLabel(transaction()).sources).toEqual([]);
  });
});
