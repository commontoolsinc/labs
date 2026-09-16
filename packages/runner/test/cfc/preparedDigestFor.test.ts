import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  deepFreeze,
  getFrozenObjectHashCacheHits,
  hashStringOf,
} from "@commonfabric/data-model";
import type { MemorySpace } from "@commonfabric/memory/interface";

import { preparedDigestFor } from "../../src/cfc/canonical.ts";
import type { PreparedDigestInput } from "../../src/cfc/types.ts";

const space: MemorySpace = "did:key:digest-test";
const address = (id: string, path: string[] = []) => ({
  space,
  scope: "space" as const,
  id: `of:${id}`,
  path,
});
const empty = (): PreparedDigestInput => ({
  consumedReads: [],
  attemptedWrites: [],
  writes: [],
  writeAttemptLog: [],
  triggerReads: [],
  dereferenceTraces: [],
  writePolicyInputs: [],
});

describe("preparedDigestFor()", () => {
  it("reuses a canonical record hashed before the first digest", () => {
    const policy = deepFreeze({
      kind: "custom" as const,
      name: "payload",
      target: address("write"),
      value: { text: "x".repeat(10240) },
    });
    hashStringOf(policy);
    const hits = getFrozenObjectHashCacheHits();
    preparedDigestFor({ ...empty(), writePolicyInputs: [policy] });
    expect(getFrozenObjectHashCacheHits() - hits).toBe(1);
  });

  it("reuses immutable record hashes across input snapshots", () => {
    const input = {
      ...empty(),
      consumedReads: [deepFreeze(address("read"))],
      dereferenceTraces: [deepFreeze({
        source: address("source"),
        target: address("target"),
        kind: "value" as const,
      })],
      writePolicyInputs: [deepFreeze({
        kind: "custom" as const,
        name: "payload",
        target: address("write", ["value", "nested"]),
        value: { text: "x".repeat(10240) },
      })],
    };
    const digest = preparedDigestFor(input);
    const hits = getFrozenObjectHashCacheHits();
    expect(preparedDigestFor({ ...input })).toBe(digest);
    expect(getFrozenObjectHashCacheHits() - hits).toBe(3);
    expect(preparedDigestFor({
      ...input,
      writePolicyInputs: [
        ...input.writePolicyInputs,
        deepFreeze({
          kind: "custom" as const,
          name: "another",
          value: "new write",
        }),
      ],
    })).not.toBe(digest);
  });

  it("observes nested mutation beneath a shallow-frozen record", () => {
    const value = { text: "first" };
    const policy = Object.freeze({ kind: "custom" as const, name: "p", value });
    const input = { ...empty(), writePolicyInputs: [policy] };
    const digest = preparedDigestFor(input);
    value.text = "second";
    expect(preparedDigestFor(input)).not.toBe(digest);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it("preserves canonical paths, trace set semantics, and policy multiplicity", () => {
    const policy = deepFreeze({
      kind: "custom" as const,
      name: "p",
      target: address("write", ["value", "nested"]),
      value: "payload",
    });
    const trace = deepFreeze({
      source: address("source", ["value", "link"]),
      target: address("target"),
      kind: "value" as const,
    });
    const input = {
      ...empty(),
      writePolicyInputs: [policy],
      dereferenceTraces: [trace],
    };
    const digest = preparedDigestFor(input);
    expect(preparedDigestFor({
      ...input,
      writePolicyInputs: [{ ...policy, target: address("write", ["nested"]) }],
      dereferenceTraces: [trace, {
        ...trace,
        source: address("source", ["link"]),
      }],
    })).toBe(digest);
    expect(preparedDigestFor({ ...input, writePolicyInputs: [policy, policy] }))
      .not.toBe(digest);
  });
});
