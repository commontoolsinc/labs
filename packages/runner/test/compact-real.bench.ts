// PROPER A/B benchmark - measures actual write costs, not just iteration
import { ChangeSet, compactChangeSet } from "../src/data-updating.ts";
import * as Attestation from "../src/storage/transaction/attestation.ts";
import type { IAttestation } from "../src/storage/interface.ts";
import type { StorableDatum } from "@commontools/memory/interface";

const space = "did:test:space" as `did:${string}:${string}`;
const docId = "test:doc" as `${string}:${string}`;

// Create a source document to write to
function makeSource(size: number): IAttestation {
  const value: Record<string, StorableDatum> = {};
  for (let i = 0; i < size; i++) {
    value["item" + i] = { a: 1, b: 2, c: 3 };
  }
  return {
    address: {
      id: docId,
      type: "application/json" as const,
      path: [] as string[],
    },
    value,
  };
}

// Create test changesets with overlap
function makeChanges(count: number, overlapPercent: number): ChangeSet {
  const changes: ChangeSet = [];
  const parentCount = Math.floor(count * overlapPercent / 100);

  // Add parent writes (full object)
  for (let i = 0; i < parentCount; i++) {
    changes.push({
      location: {
        id: docId,
        space,
        type: "application/json",
        path: ["item" + i],
      },
      value: { a: 1, b: 2, c: 3 },
    });
  }

  // Add child writes (overlap with parents - these are redundant)
  for (let i = 0; i < count - parentCount; i++) {
    const parentIdx = i % Math.max(1, parentCount);
    changes.push({
      location: {
        id: docId,
        space,
        type: "application/json",
        path: ["item" + parentIdx, "a"],
      },
      value: 1,
    });
  }

  return changes;
}

// Simulate what happens WITHOUT compactChangeSet
function writesWithoutCompact(
  source: IAttestation,
  changes: ChangeSet,
) {
  let current = source;
  for (const change of changes) {
    const result = Attestation.write(
      current,
      { ...current.address, path: change.location.path },
      change.value,
    );
    if (result.ok) current = result.ok;
  }
  return current;
}

// Simulate what happens WITH compactChangeSet
function writesWithCompact(
  source: IAttestation,
  changes: ChangeSet,
) {
  const compacted = compactChangeSet(changes);
  let current = source;
  for (const change of compacted) {
    const result = Attestation.write(
      current,
      { ...current.address, path: change.location.path },
      change.value,
    );
    if (result.ok) current = result.ok;
  }
  return current;
}

// Test cases
const source20 = makeSource(20);
const changes20_25 = makeChanges(20, 25); // 5 parents + 15 children = 5 redundant
const changes20_50 = makeChanges(20, 50); // 10 parents + 10 children = 10 redundant

const source100 = makeSource(100);
const changes100_40 = makeChanges(100, 40); // 40 parents + 60 children

Deno.bench({
  name: "20 changes, 25% overlap - WITHOUT compactChangeSet",
  group: "20_25",
}, () => {
  writesWithoutCompact(source20, changes20_25);
});

Deno.bench({
  name: "20 changes, 25% overlap - WITH compactChangeSet",
  group: "20_25",
}, () => {
  writesWithCompact(source20, changes20_25);
});

Deno.bench({
  name: "20 changes, 50% overlap - WITHOUT compactChangeSet",
  group: "20_50",
}, () => {
  writesWithoutCompact(source20, changes20_50);
});

Deno.bench({
  name: "20 changes, 50% overlap - WITH compactChangeSet",
  group: "20_50",
}, () => {
  writesWithCompact(source20, changes20_50);
});

Deno.bench({
  name: "100 changes, 40% overlap - WITHOUT compactChangeSet",
  group: "100_40",
}, () => {
  writesWithoutCompact(source100, changes100_40);
});

Deno.bench({
  name: "100 changes, 40% overlap - WITH compactChangeSet",
  group: "100_40",
}, () => {
  writesWithCompact(source100, changes100_40);
});
