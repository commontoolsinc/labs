# Schema Transformer Unification Plan

## Context

The schema injection transformer has evolved organically with inconsistent approaches across different transformation paths (pattern, derive, recipe, handler, lift). This document outlines a systematic approach to unify the design.

## Key Inconsistencies Identified

### 1. TypeRegistry Usage
- **Handler & Derive**: Check TypeRegistry for closure-captured types
- **Lift**: Explicitly ignores TypeRegistry (passes `undefined`)
- **Recipe & Pattern**: Never interact with TypeRegistry

### 2. Strictness/Fallback Policy
- **Recipe**: Strictest - won't transform without explicit types
- **Handler**: Most lenient - always transforms, uses `unknown` (schema: `true`) as fallback
- **Pattern/Derive/Lift**: Moderate - accept partial types, skip if unavailable

### 3. Type Source Strategy
- **Recipe**: User annotations ONLY (no inference)
- **Pattern**: Hybrid (explicit first, then infer with type arg hints)
- **Handler**: Explicit or `unknown` (minimal inference)
- **Derive**: Heavy inference from arguments and context
- **Lift**: Inference from function signature

### 4. Shared Infrastructure
- `collectFunctionSchemaTypeNodes()` helper used by Pattern, Derive, Lift
- **NOT** used by Handler or Recipe (they have inline logic)

## Unknown Type Schema

When fallback to `unknown` occurs, the generated schema is:
```json
true
```
This is the most permissive JSON Schema - accepts any value at runtime.

## Unification Strategy: Phased Experimentation

**Philosophy**: Make changes incrementally, let failures teach us whether inconsistencies were necessary or accidental.

### Phase 1: TypeRegistry Unification
**Hypothesis**: All paths should check TypeRegistry for closure-captured types

**Changes**:
1. Make Lift check TypeRegistry (currently ignores it)
2. Make Recipe & Pattern check TypeRegistry (currently don't interact)
3. Add explicit documentation for Handler/Derive TypeRegistry checks

**Test Strategy**:
- Create test patterns using closures in each context
- Run existing test suite
- Document what breaks and why

**Success Criteria**: Either (a) everything works better, or (b) specific breaks reveal why some paths avoided TypeRegistry

---

### Phase 2: Shared Type Collection Helper
**Hypothesis**: All paths should use `collectFunctionSchemaTypeNodes()` or unified variant

**Changes**:
1. Refactor Handler to use collectFunctionSchemaTypeNodes
2. Refactor Recipe to use collectFunctionSchemaTypeNodes
3. Extend helper if needed for their specific requirements

**Test Strategy**: Same behavior before/after refactor

**Success Criteria**: Cleaner code with identical behavior, or reveals why Handler/Recipe needed special logic

---

### Phase 3: Consistent Fallback Policy
**Hypothesis**: TBD - this might legitimately differ by function semantics

**Options to Explore**:
- **Option A**: Strict everywhere (skip transformation without types)
- **Option B**: Lenient everywhere (always transform, use `unknown` / `true` schema)
- **Option C**: Documented per-function policy based on semantics

**Test Strategy**:
- Try strict approach everywhere first
- Analyze breaks: "catching bugs" vs "breaking valid code"
- Consider semantic meaning of each function

**Success Criteria**: Either consistent policy or documented rationale for differences

---

### Phase 4: Type Parameter Error Handling
**Hypothesis**: Should consistently error/warn on uninstantiated generics

**Changes**:
1. Add explicit check for uninstantiated type parameters
2. Emit compiler diagnostic (error or warning - TBD)
3. Make behavior consistent across all paths

**Test Strategy**:
- Uninstantiated generics trigger warnings
- Instantiated generics work fine
- Clear error messages guide users

**Success Criteria**: Better DX, catches bugs earlier, consistent behavior

---

## Execution Plan

### Pre-Work: Baseline Tests
```bash
# Capture current test state
deno task test packages/ts-transformers > baseline-tests.txt
deno task test:integration > baseline-integration.txt
```

### Per-Phase Workflow
1. Create branch `refactor/unify-[phase-name]`
2. Implement changes for that phase
3. Run tests and document failures
4. **Decision point**: Fix breaks or revert?
5. Document learnings
6. PR with findings

### Post-Work: Design Documentation
After all phases, write up:
- Which unifications worked
- Which failed and why (with evidence)
- Resulting "intentional design" documentation

## Current Status

- **Branch**: Starting from `wish-schemas` (includes uninstantiated generics work)
- **Next Step**: Phase 1 (TypeRegistry Unification)
- **Complete Analysis**: See `schema-transformer-analysis.md`

## Notes

- Some inconsistencies may prove necessary
- Failures are informative, not setbacks
- Each phase builds understanding
- Goal is coherent, documented design - not necessarily uniform behavior
