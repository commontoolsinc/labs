/**
 * Benchmarks for the CFC canonicalization helpers and watch-key construction.
 *
 * The functions exercised here are on the hot path of the CFC commit-boundary
 * gate (`preparedDigestFor` is called from
 * `extended-storage-transaction.ts` on every prepare and again during commit
 * re-check) and on the storage subscription path (`watchIdForEntry` is hit
 * once per watch registration).
 *
 * Tracked metrics live under `bench: packages/runner/test/cfc-canonicalize.bench.ts > ...`
 * once `benchmarks.yml` runs on a main-branch push and the artifact is
 * ingested by `tasks/perf-regression.ts`.
 */

import { preparedDigestFor, type PreparedDigestInput } from "../src/cfc/mod.ts";
import { canonicalizePreparedDigestInput } from "../src/cfc/canonical.ts";
import { watchIdForEntry } from "../src/storage/v2-watch.ts";
import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { WritePolicyInput } from "../src/cfc/types.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const SPACE: MemorySpace =
  "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSdoom8Beere1L9DwwTm";

const makeAddress = (idSuffix: string, ...path: (string | number)[]) => ({
  space: SPACE,
  id: `of:doc-${idSuffix}`,
  type: "application/json",
  path: ["value", ...path.map(String)],
});

// Pre-freeze each `WritePolicyInput`, mirroring what the production chokepoint
// (`recordCfcWritePolicyInput`) does on entry. Bench fixtures otherwise come
// out mutable and don't reflect the production cache-eligibility shape.
const freezePolicies = (
  policies: WritePolicyInput[],
): WritePolicyInput[] => {
  for (const p of policies) deepFreeze(p);
  return policies;
};

// A small `PreparedDigestInput` that approximates a typical pattern-tick
// boundary: a handful of reads and writes, one or two policy inputs, no
// dereferences. Realistic for a simple Cell.set() commit.
const SMALL_INPUT: PreparedDigestInput = {
  consumedReads: [
    makeAddress("a", "items"),
    makeAddress("b", "title"),
  ],
  potentialWrites: [
    makeAddress("a", "items", 0),
  ],
  writes: [
    makeAddress("a", "items", 0),
  ],
  dereferenceTraces: [],
  writePolicyInputs: freezePolicies([
    {
      kind: "schema",
      target: makeAddress("a", "items", 0),
      schemaHash: "schemaHash-1",
    },
  ]),
  implementationIdentity: { kind: "builtin", builtinId: "test-builtin" },
  trustSnapshot: undefined,
};

// A larger `PreparedDigestInput` that approximates a busy commit: a dozen
// reads, several writes, multiple dereference traces, a varied set of policy
// inputs across kinds. This is where the canonical-sort costs scale.
const LARGE_INPUT: PreparedDigestInput = {
  consumedReads: Array.from(
    { length: 12 },
    (_, i) => makeAddress(`r${i}`, "field", i),
  ),
  potentialWrites: Array.from(
    { length: 4 },
    (_, i) => makeAddress(`w${i}`, "out", i),
  ),
  writes: Array.from({ length: 4 }, (_, i) => makeAddress(`w${i}`, "out", i)),
  dereferenceTraces: Array.from({ length: 6 }, (_, i) => ({
    source: makeAddress(`d${i}`, "src"),
    target: makeAddress(`d${i}`, "dst"),
    kind: i % 2 === 0 ? "value" as const : "write-redirect" as const,
  })),
  writePolicyInputs: freezePolicies([
    {
      kind: "schema",
      target: makeAddress("w0", "out", 0),
      schemaHash: "schemaHash-1",
    } satisfies WritePolicyInput,
    {
      kind: "schema",
      target: makeAddress("w1", "out", 1),
      schemaHash: "schemaHash-2",
    } satisfies WritePolicyInput,
    {
      kind: "trusted-event",
      target: makeAddress("w2", "out", 2),
      eventId: "evt-1",
    } satisfies WritePolicyInput,
    {
      kind: "link-write",
      target: makeAddress("w3", "out", 3),
      source: makeAddress("ref", "linked"),
    } satisfies WritePolicyInput,
    {
      kind: "custom",
      name: "policy-b",
      value: { allow: true },
    } satisfies WritePolicyInput,
    {
      kind: "custom",
      name: "policy-a",
      value: { allow: false },
    } satisfies WritePolicyInput,
  ]),
  implementationIdentity: { kind: "builtin", builtinId: "test-builtin" },
  trustSnapshot: undefined,
};

// A tiebreak-heavy fixture: many `custom` policies that share `kind` AND
// `name`, forcing every pairwise sort comparison through the
// `hashStringOf()` tiebreaker. With the chokepoint freeze in place each
// frozen input is cache-eligible, so the within-sort cache fires from
// iteration two onward; without it, every comparator call rehashes from
// scratch. Synthetic worst case, included so the regression detector flags
// any future regression in the cache-eligibility pathway.
const TIEBREAK_HEAVY_INPUT: PreparedDigestInput = {
  consumedReads: [],
  potentialWrites: [],
  writes: [],
  dereferenceTraces: [],
  writePolicyInputs: freezePolicies(
    Array.from({ length: 8 }, (_, i) => ({
      kind: "custom" as const,
      name: "shared-name",
      value: { discriminator: i, payload: `value-${i}` },
    } satisfies WritePolicyInput)),
  ),
  implementationIdentity: { kind: "builtin", builtinId: "test-builtin" },
  trustSnapshot: undefined,
};

Deno.bench(
  "preparedDigestFor — small (typical pattern-tick boundary)",
  { group: "preparedDigestFor" },
  () => {
    preparedDigestFor(SMALL_INPUT);
  },
);

Deno.bench(
  "preparedDigestFor — large (busy commit with 12 reads, 6 traces, 6 policies)",
  { group: "preparedDigestFor" },
  () => {
    preparedDigestFor(LARGE_INPUT);
  },
);

Deno.bench(
  "canonicalizePreparedDigestInput only — large (sort/comparator cost, no final hash)",
  { group: "preparedDigestFor" },
  () => {
    canonicalizePreparedDigestInput(LARGE_INPUT);
  },
);

Deno.bench(
  "preparedDigestFor — tiebreak-heavy (8 custom policies sharing kind+name)",
  { group: "preparedDigestFor" },
  () => {
    preparedDigestFor(TIEBREAK_HEAVY_INPUT);
  },
);

// ---------------------------------------------------------------------------
// watchIdForEntry — exercises hashStringOf on a fresh, ad-hoc watch key
// ---------------------------------------------------------------------------

const WATCH_SCHEMA: JSONSchema = internSchema({
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
});

const WATCH_ADDRESS = {
  id: `of:doc-watch` as const,
  type: "application/json" as const,
};

const WATCH_SELECTOR = {
  path: ["value", "items"],
  schema: WATCH_SCHEMA,
};

Deno.bench(
  "watchIdForEntry — typical address + interned-schema selector",
  { group: "watchIdForEntry" },
  () => {
    watchIdForEntry(WATCH_ADDRESS, WATCH_SELECTOR, "main");
  },
);
