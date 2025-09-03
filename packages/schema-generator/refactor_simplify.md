# Formatter Simplification Plan

This document captures a focused, incremental plan to simplify the
`@commontools/schema-generator` formatters without changing observable behavior.
We aim to make ObjectFormatter thin and delegate-first, and to localize wrapper
semantics in CommonToolsFormatter.

## Goals

- Reduce duplicated logic across formatters (especially Cell/Stream).
- Keep wrapper semantics (Cell/Stream/Default) in CommonToolsFormatter only.
- Keep ObjectFormatter focused on property enumeration + minimal guards.
- Preserve behavior verified by fixtures and unit tests.

## Current State (post-initial cleanup)

- ObjectFormatter delegates to the generator, with two minimal array guards:
  1) Fast-path for Array<T>/ReadonlyArray<T> property nodes.
  2) Final guard: synthesize array from node if a formatter returned an overly
     generic shape for an ArrayTypeNode.
- CommonToolsFormatter:
  - Default<T,V> handles defaults and nullability (node-first union detection).
  - Cell<T> and Stream<T> handle flags + array wrapping. Alias-of-alias array
    synthesis remains for Cell.
  - Some array detection logic is duplicated between Cell and Stream.

## Simplifications (next steps)

1) Consolidate array detection in CommonToolsFormatter
   - Add a small helper used by both `formatCellType` and `formatStreamType`:
     `private getArrayItemsSchema(
        valueType: ts.Type,
        valueNode: ts.TypeNode | undefined,
        checker: ts.TypeChecker,
        context: FormatterContext
      ): SchemaDefinition | undefined`
     Behavior:
     - If `valueNode` is `ArrayTypeNode`, return `schemaGenerator.formatChildType`
       of the element as `{ type: "array", items }`.
     - Else call `getArrayElementType(valueType, checker, valueNode)`. If found,
       return `{ type: "array", items }`.
     - Alias-specific handling for `Cell<T[]>` remains in `formatCellType` via the
       existing alias helper.

2) Deduplicate Cell/Stream array logic
   - Replace inline array detection in both formatters with the shared helper.
   - Cell: keep alias-of-alias special case first; otherwise use the helper.
   - Stream: use the helper, then handle `asStream` and `asCell` flags.

3) Prune leftover patches
   - Ensure no remaining `Default<T,V>` default propagation in Cell/Stream.
   - Ensure Stream’s Cell detection always checks both node and type identity,
     but without relying on undefined locals.

4) Guardrails
   - Do not change `Default<T,V>` behavior (already centralized).
   - Keep alias-of-alias Cell<T[]> handling as-is (real test coverage).
   - Keep ObjectFormatter’s minimal array guards.

5) Verification
   - Run `deno task test` for schema-generator.
   - If needed, expand fixtures to cover edge cases discovered.

## Future (optional)

- If `getArrayElementType` becomes sufficient for all cases, consider removing
  ObjectFormatter’s final array guard and Cell alias synthesis in favor of a
  single robust detection path.
- Consider extracting the alias-aware helper(s) into `type-utils.ts` if we
  want to reuse them elsewhere.

