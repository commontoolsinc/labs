# TS Transformers Review Guide

**Status:** concise reviewer entrypoint for PR 3154 **Audience:** reviewers who
want the current architecture, settled invariants, and explicit non-goals
without rereading the whole branch history

## Read This First

1. [ts_transformers_target_pattern_language_spec.md](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md)
   - normative source-language / target-language boundary
2. [ts_transformers_lowering_contract.md](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/docs/specs/ts-transformer/ts_transformers_lowering_contract.md)
   - normative lowering contract
3. [ts_transformers_current_behavior_spec.md](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md)
   - implemented behavior and current compatibility details
4. [ts_transformers_design_deltas.md](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/docs/specs/ts-transformer/ts_transformers_design_deltas.md)
   - hardening follow-ups and deliberate deltas from older behavior

## Rollout Status

- Current activation is still opt-in via first-line `/// <cts-enable />`.
- This PR should be reviewed as a candidate **default path**, not as the
  default-on rollout itself.
- Default-on rollout should only happen after:
  - contract/spec review is settled
  - first-party migration expectations are explicit
  - integration/performance rollout gates are defined outside this PR

## Migration Doctrine

- If authored code is inside the supported target language, CTS should absorb it
  without requiring authors to learn implementation trivia.
- If authored code is outside the target language, CTS should either:
  - lower it through an explicit supported rule, or
  - emit a direct diagnostic / guidance boundary
- Review first-party pattern edits in this PR as:
  - evidence about the current supported boundary
  - not automatically as the desired permanent authoring style unless the spec
    says so explicitly

## Architecture In One Pass

- JSX is no longer the semantics engine. It is mostly a routing / ownership
  sink.
- Validation and lowering now share more real policy seams instead of
  rediscovering support independently.
- Schema behavior is now explicitly split between:
  - semantic `any` -> `true`
  - semantic `unknown` -> `{ type: "unknown" }`
  - unresolved generic definition-site type params -> `{ type: "unknown" }`
- `capability-lowering.ts` is no longer the central junk drawer; major
  responsibilities are split into focused policy and transform files.

## Files To Review

- [expression-site-policy.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/src/transformers/expression-site-policy.ts)
  - shared expression-site handling decision
- [call-kind.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/src/ast/call-kind.ts)
  - call family / ownership / callback-container classification
- [callback-boundary.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/src/policy/callback-boundary.ts)
  - shared callback-boundary semantics for context + validation
- [pattern-context-validation.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/src/transformers/pattern-context-validation.ts)
  - restricted-context validation and builder placement
- [pattern-body-reactive-root-lowering.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/src/transformers/pattern-body-reactive-root-lowering.ts)
  - remaining tracked-reactive body rewrite seam
- [schema-injection.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/src/transformers/schema-injection.ts)
  - schema injection, fallback policy, registry-aware recovery

## Compact Schema Matrix

| Case                                                                          | Current rule                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pattern()` result inferred as `any`                                          | emit `true`                                                              |
| `pattern()` result inferred as `unknown`                                      | emit `{ type: "unknown" }`                                               |
| inline-destructured `pattern(({...}: T) => ...)` vs `pattern<T>(...)`         | equivalent input/result schemas                                          |
| generic helper definition site `wish<T>` / `generateObject<T>` / `Cell.of<T>` | degrade unresolved type params to `{ type: "unknown" }`                  |
| explicit-generic builder definition site `lift<T, U>` / `handler<E, S>`       | degrade unresolved type params to `{ type: "unknown" }`                  |
| transformed structural cell values                                            | preserve recovered structure rather than collapsing to `any` / `unknown` |
| reactive array element access `items[index]`                                  | preserve `string                                                         |
| boolean result schemas                                                        | normalized as plain `type: "boolean"` in current supported cases         |

Primary proof surface:

- [schema-shrink-validation.test.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/test/schema-shrink-validation.test.ts)
- [schema-injection-new.test.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/test/schema-injection-new.test.ts)
- [validation.test.ts](/Users/gideonwald/coding/common-fabric/labs-pattern-language-boundary/packages/ts-transformers/test/validation.test.ts)

## Current Open Review Question

- JSX / render-node schema verbosity
  - current output is semantically consistent, but repeated render-node shapes
    and local `$defs` are still noisy
  - the remaining question is presentation/canonicalization, not core
    correctness

## Explicitly Not In This PR

- flipping CTS to default-on everywhere
- removing the current `/// <cts-enable />` rollout gate
- call-site specialization for generic helpers
- broader interprocedural capability-analysis expansion beyond the current
  landed slice
- removing deprecated bare `cell(...)` compatibility support

## Fast Review Path

1. Read the two normative specs.
2. Skim this matrix to see the settled schema invariants.
3. Review `expression-site-policy.ts`, `call-kind.ts`, `callback-boundary.ts`,
   and `schema-injection.ts` as the main semantic sources of truth.
4. Use the three schema/validation test files above as the compact proof
   surface.
