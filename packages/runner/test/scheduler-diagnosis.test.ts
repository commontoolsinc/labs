import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  type DiagnosisRecord,
  findDifferingWriteKeys,
  findNonIdempotentPair,
  makeAddressKey,
} from "../src/scheduler/diagnosis.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

const SPACE = "did:key:zDiagnosis" as IMemorySpaceAddress["space"];

function address(id: string, path: string[]): IMemorySpaceAddress {
  return { space: SPACE, id: id as IMemorySpaceAddress["id"], path };
}

function record(
  reads: Record<string, FabricValue>,
  writes: Record<string, FabricValue>,
): DiagnosisRecord {
  return {
    readValues: new Map(Object.entries(reads)),
    writeValues: new Map(Object.entries(writes)),
    timestamp: 0,
  };
}

describe("makeAddressKey", () => {
  it("joins space, id, and path with slashes", () => {
    expect(makeAddressKey(address("of:e1", ["a", "b"]))).toBe(
      "did:key:zDiagnosis/of:e1/a/b",
    );
  });

  it("leaves a trailing slash for an empty path", () => {
    expect(makeAddressKey(address("of:e1", []))).toBe(
      "did:key:zDiagnosis/of:e1/",
    );
  });
});

describe("findDifferingWriteKeys", () => {
  it("flags keys present in only one map", () => {
    const previous = new Map<string, FabricValue>([["a", 1]]);
    const latest = new Map<string, FabricValue>([["b", 2]]);
    expect(findDifferingWriteKeys(previous, latest).sort()).toEqual(["a", "b"]);
  });

  it("flags keys whose value changed and ignores equal values", () => {
    const previous = new Map<string, FabricValue>([["a", 1], ["b", { x: 1 }]]);
    const latest = new Map<string, FabricValue>([["a", 2], ["b", { x: 1 }]]);
    expect(findDifferingWriteKeys(previous, latest)).toEqual(["a"]);
  });

  it("restricts the compared keys to the latest map when asked", () => {
    const previous = new Map<string, FabricValue>([["a", 1], ["gone", 9]]);
    const latest = new Map<string, FabricValue>([["a", 1], ["b", 2]]);
    // Union counts the key that only the previous map holds; "latest" does not.
    expect(findDifferingWriteKeys(previous, latest).sort()).toEqual([
      "b",
      "gone",
    ]);
    expect(
      findDifferingWriteKeys(previous, latest, { keySet: "latest" }),
    ).toEqual(["b"]);
  });
});

describe("findNonIdempotentPair", () => {
  it("returns undefined with fewer than two records", () => {
    expect(findNonIdempotentPair([])).toBeUndefined();
    expect(findNonIdempotentPair([record({ r: 1 }, { w: 1 })])).toBeUndefined();
  });

  it("finds a pair with equal reads but differing writes", () => {
    const previous = record({ r: 1 }, { w: 1 });
    const latest = record({ r: 1 }, { w: 2 });
    const pair = findNonIdempotentPair([previous, latest]);
    expect(pair).toBeDefined();
    expect(pair!.previous).toBe(previous);
    expect(pair!.latest).toBe(latest);
    expect(pair!.differingWriteKeys).toEqual(["w"]);
  });

  it("returns undefined when reads differ between the runs", () => {
    const previous = record({ r: 1 }, { w: 1 });
    const latest = record({ r: 2 }, { w: 2 });
    expect(findNonIdempotentPair([previous, latest])).toBeUndefined();
  });

  it("returns undefined when reads and writes both match", () => {
    const previous = record({ r: 1 }, { w: 1 });
    const latest = record({ r: 1 }, { w: 1 });
    expect(findNonIdempotentPair([previous, latest])).toBeUndefined();
  });
});
