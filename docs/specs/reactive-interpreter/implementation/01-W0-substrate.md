# W0 — Substrate & Instrument

> Status: in progress. Exit checklist at the bottom. Update
> [`PROGRESS.md`](./PROGRESS.md) as steps land.

W0 builds the foundation the rest of the work is *measured* against (G5/G6) and
the IR contract the interpreter will execute — **without** yet building the
interpreter. It also re-verifies the scheduler seam against landed code so W1+
don't build on drifted assumptions.

## Deliverables

1. **Reusable measurement harness** (`packages/runner/test/support/interpreter-measure.ts`):
   graduate the throwaway spike probes into durable, generic instruments —
   - `attachDocRecorder`: distinct documents created + per-write path-length
     (whole-doc vs path-scoped patch);
   - `nodeStats`: scheduler graph node counts by type + total run count;
   - `derivedConfidentiality` / label probe (the CFC oracle metric);
   - `measurePattern(env, pattern, inputs)`: runs a pattern, returns
     `{docs, nodes, mapped, editReruns, editWrites}` — generic over *any*
     pattern (legacy today; interpreted later).
2. **Baseline regression bench** (`packages/runner/test/reactive-interpreter/baseline.bench-test.ts`):
   re-emits the legacy `map` law (`docs ≈ 5 + 3N`, `nodes ≈ 8 + 4N`) using the
   harness, as the durable "before" the interpreter is compared to.
3. **The ROG type** (`packages/runner/src/reactive-interpreter/rog.ts`): the
   data IR from [02-design](../02-design.md) §1.1 (Op kinds, ValueRef, Rog) as a
   real typed module. Types only — no execution.
4. **`Pattern → ROG` extraction** (`packages/runner/src/reactive-interpreter/extract.ts`):
   normalize the existing serialized `Pattern` (`{argumentSchema, resultSchema,
   result, nodes}`) into the flat ROG vocabulary, with a **coverage test** over
   real patterns reporting what fraction extract cleanly (honest coverage, not a
   claim of completeness).
5. **Seam re-verification** (`reverify-scheduler-seam` workflow → findings folded
   into [`DECISIONS.md`](./DECISIONS.md)): confirm scheduler reality (v1/v2),
   what the builtin node seam allows today, and the net-new runtime work.

## Steps (one commit each, G1)

- **W0.1** harness support module + unit smoke test.
- **W0.2** baseline regression bench (legacy law) via the harness.
- **W0.3** ROG type module.
- **W0.4** extraction + coverage test.
- **W0.5** fold seam-verification findings into DECISIONS; record divergences.

## Exit checklist

1. Harness compiles + the baseline bench reproduces the legacy law (measured).
2. ROG type compiles and matches 02-design §1.1.
3. Extraction round-trips / reports coverage on the real corpus; gaps listed.
4. Seam findings + divergences recorded in DECISIONS.
5. PROGRESS updated with the measured baseline numbers.
6. Adversarial review (cf-review / workflow) against this checklist.
