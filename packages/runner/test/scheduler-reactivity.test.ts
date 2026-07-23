import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  IMemorySpaceAddress,
  MemorySpace,
  URI,
} from "../src/storage/interface.ts";
import { classifyTelemetryWriteCounts } from "../src/scheduler/reactivity.ts";

const space = "did:key:telemetry" as MemorySpace;

function address(path: string[]): IMemorySpaceAddress {
  return {
    space,
    scope: "space",
    id: "of:fid1:telemetry" as URI,
    path,
  };
}

describe("event commit telemetry write counts", () => {
  it("counts an exact same-value leaf set as one no-op candidate", () => {
    expect(
      classifyTelemetryWriteCounts([], [
        address(["value", "title"]),
      ]),
    )
      .toEqual({ changedWriteCount: 0, writeCount: 1 });
  });

  it("counts an ordinary changed scalar without a no-op candidate", () => {
    expect(classifyTelemetryWriteCounts(
      [address(["value", "title"])],
      [address(["value", "title"])],
    )).toEqual({ changedWriteCount: 1, writeCount: 1 });
  });

  it("does not classify a parent attempt overlapping a changed child as no-op", () => {
    expect(classifyTelemetryWriteCounts(
      [address(["value", "topic", "title"])],
      [address(["value", "topic"])],
    )).toEqual({ changedWriteCount: 1, writeCount: 1 });
  });

  it("deduplicates identical attempted targets", () => {
    expect(classifyTelemetryWriteCounts([], [
      address(["value", "title"]),
      address(["value", "title"]),
    ])).toEqual({ changedWriteCount: 0, writeCount: 1 });
  });

  it("classifies large disjoint write sets without pairwise comparisons", () => {
    const changed = Array.from(
      { length: 1000 },
      (_entry, index) => address(["changed", String(index)]),
    );
    const attempted = Array.from(
      { length: 1000 },
      (_entry, index) => address(["attempted", String(index)]),
    );
    expect(classifyTelemetryWriteCounts(changed, attempted)).toEqual({
      changedWriteCount: 1000,
      writeCount: 2000,
    });
  });

  it("classifies deeply nested paths without rebuilding every prefix", () => {
    const common = Array.from({ length: 5_000 }, (_, index) => `p${index}`);
    expect(classifyTelemetryWriteCounts(
      [address([...common, "changed"])],
      [address([...common, "attempted"])],
    )).toEqual({ changedWriteCount: 1, writeCount: 2 });
    expect(classifyTelemetryWriteCounts(
      [address([...common, "changed"])],
      [address(common)],
    )).toEqual({ changedWriteCount: 1, writeCount: 1 });
  });
});
