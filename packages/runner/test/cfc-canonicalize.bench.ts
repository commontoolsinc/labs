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
import {
  canonicalizeLogicalPath,
  canonicalizePreparedDigestInput,
} from "../src/cfc/canonical.ts";
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
  scope: "space" as const,
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

// Produce a "warm" copy of an input — paths canonicalized + frozen, every
// record deep-frozen — mirroring the post-`buildPreparedDigestInput` shape
// that `preparedDigestFor` actually sees in production. The cold variants
// (no leading-`"value"` strip, unfrozen) measure the first-time
// canonicalize cost paid once at the chokepoint; warm variants measure
// the steady-state per-`preparedDigestFor` cost.
const warm = (input: PreparedDigestInput): PreparedDigestInput => {
  const warmAddr = <T extends { path: readonly string[] }>(a: T): T =>
    deepFreeze({ ...a, path: canonicalizeLogicalPath(a.path) });
  return deepFreeze({
    consumedReads: input.consumedReads.map(warmAddr),
    attemptedWrites: input.attemptedWrites.map(warmAddr),
    writes: input.writes.map(warmAddr),
    // Attempt-log paths stay RAW by contract (no canonicalization), so
    // warming is just the chokepoint freeze.
    writeAttemptLog: input.writeAttemptLog.map((a) => deepFreeze({ ...a })),
    dereferenceTraces: input.dereferenceTraces.map((t) =>
      deepFreeze({
        ...t,
        source: warmAddr(t.source),
        target: warmAddr(t.target),
      })
    ),
    triggerReads: input.triggerReads.map(warmAddr),
    writePolicyInputs: input.writePolicyInputs,
    implementationIdentity: input.implementationIdentity,
    trustSnapshot: input.trustSnapshot,
  });
};

// Attempt-log mirror of a fixture's `writes`, with interleave-plausible
// clock stamps (reads land between attempts in production; exact spacing is
// irrelevant to the sort cost being measured).
const attemptLogFor = (
  writes: readonly { path: readonly string[] }[],
): PreparedDigestInput["writeAttemptLog"] =>
  writes.map((w, i) => ({
    ...(w as PreparedDigestInput["writeAttemptLog"][number]),
    journalIndex: i * 2 + 1,
  }));

// A small `PreparedDigestInput` that approximates a typical pattern-tick
// boundary: a handful of reads and writes, one or two policy inputs, no
// dereferences. Realistic for a simple Cell.set() commit.
const SMALL_INPUT: PreparedDigestInput = {
  consumedReads: [
    makeAddress("a", "items"),
    makeAddress("b", "title"),
  ],
  attemptedWrites: [
    makeAddress("a", "items", 0),
  ],
  writes: [
    makeAddress("a", "items", 0),
  ],
  writeAttemptLog: attemptLogFor([makeAddress("a", "items", 0)]),
  dereferenceTraces: [],
  triggerReads: [],
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
  attemptedWrites: Array.from(
    { length: 4 },
    (_, i) => makeAddress(`w${i}`, "out", i),
  ),
  writes: Array.from({ length: 4 }, (_, i) => makeAddress(`w${i}`, "out", i)),
  writeAttemptLog: attemptLogFor(
    Array.from({ length: 4 }, (_, i) => makeAddress(`w${i}`, "out", i)),
  ),
  dereferenceTraces: Array.from({ length: 6 }, (_, i) => ({
    source: makeAddress(`d${i}`, "src"),
    target: makeAddress(`d${i}`, "dst"),
    kind: i % 2 === 0 ? "value" as const : "write-redirect" as const,
  })),
  triggerReads: [],
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
  attemptedWrites: [],
  writes: [],
  writeAttemptLog: [],
  dereferenceTraces: [],
  triggerReads: [],
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

// A path-heavy fixture: every read / write / trace shares the same
// `(space, id)`, so `compareAddress()` always falls through to the path
// step and `logicalPathToPointer()` fires on every comparator pair. This
// is realistic for a pattern-tick that touches many fields of a single
// document. Per runner-test instrumentation, ~82% of `compareAddress()`
// calls in real workloads reach the path step, so this fixture is closer
// to "production shape" than `LARGE_INPUT` (which has all-distinct ids).
// Included so any future regression in path-canonicalization or the
// path-step compare pathway will surface in the hourly drift detector.
const PATH_HEAVY_INPUT: PreparedDigestInput = {
  consumedReads: Array.from({ length: 12 }, (_, i) => ({
    space: SPACE,
    id: "of:doc-shared",
    scope: "space" as const,
    path: ["value", "items", String(i), "field", String(i)],
  })),
  attemptedWrites: Array.from({ length: 4 }, (_, i) => ({
    space: SPACE,
    id: "of:doc-shared",
    scope: "space" as const,
    path: ["value", "out", String(i)],
  })),
  writes: Array.from({ length: 4 }, (_, i) => ({
    space: SPACE,
    id: "of:doc-shared",
    scope: "space" as const,
    path: ["value", "out", String(i)],
  })),
  writeAttemptLog: attemptLogFor(
    Array.from({ length: 4 }, (_, i) => ({
      space: SPACE,
      id: "of:doc-shared",
      scope: "space" as const,
      path: ["value", "out", String(i)],
    })),
  ),
  dereferenceTraces: Array.from({ length: 6 }, (_, i) => ({
    source: {
      space: SPACE,
      id: "of:doc-shared",
      scope: "space" as const,
      path: ["value", "src", String(i)],
    },
    target: {
      space: SPACE,
      id: "of:doc-shared",
      scope: "space" as const,
      path: ["value", "dst", String(i)],
    },
    kind: i % 2 === 0 ? "value" as const : "write-redirect" as const,
  })),
  triggerReads: [],
  writePolicyInputs: [],
  implementationIdentity: { kind: "builtin", builtinId: "test-builtin" },
  trustSnapshot: undefined,
};

const WARM_LARGE_INPUT = warm(LARGE_INPUT);
const WARM_PATH_HEAVY_INPUT = warm(PATH_HEAVY_INPUT);

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

Deno.bench(
  "preparedDigestFor — path-heavy (all addresses share space+id; differ by path)",
  { group: "preparedDigestFor" },
  () => {
    preparedDigestFor(PATH_HEAVY_INPUT);
  },
);

Deno.bench(
  "canonicalizePreparedDigestInput only — path-heavy",
  { group: "preparedDigestFor" },
  () => {
    canonicalizePreparedDigestInput(PATH_HEAVY_INPUT);
  },
);

Deno.bench(
  "preparedDigestFor — large WARM (post-build-chokepoint shape)",
  { group: "preparedDigestFor" },
  () => {
    preparedDigestFor(WARM_LARGE_INPUT);
  },
);

Deno.bench(
  "canonicalizePreparedDigestInput only — large WARM",
  { group: "preparedDigestFor" },
  () => {
    canonicalizePreparedDigestInput(WARM_LARGE_INPUT);
  },
);

Deno.bench(
  "preparedDigestFor — path-heavy WARM",
  { group: "preparedDigestFor" },
  () => {
    preparedDigestFor(WARM_PATH_HEAVY_INPUT);
  },
);

Deno.bench(
  "canonicalizePreparedDigestInput only — path-heavy WARM",
  { group: "preparedDigestFor" },
  () => {
    canonicalizePreparedDigestInput(WARM_PATH_HEAVY_INPUT);
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
