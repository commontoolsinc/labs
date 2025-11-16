# Schema Injection Transformer Analysis

## Executive Summary

The SchemaInjectionTransformer handles 5 transformation paths (pattern, derive,
recipe, handler, lift) with significant inconsistencies. The most critical
finding: **handler and derive check TypeRegistry for ClosureTransformer-injected
types, while lift explicitly ignores it**. Handler uniquely accepts `unknown`
types and always transforms, while recipe strictly requires explicit types.
These differences appear intentional based on use cases, but create an
inconsistent developer experience.

## Overview

The SchemaInjectionTransformer injects JSON schema arguments into CommonTools
core functions. It operates after ClosureTransformer, extracting/inferring type
information and wrapping it in `toSchema<T>()` calls for later schema
generation.

**Two execution contexts:**

1. Standalone invocations with explicit type arguments
2. JSX/closure invocations where ClosureTransformer created synthetic types

## Transformation Paths

### 1. Recipe Transformation (Lines 168-244)

#### Type Source Strategy

**Dual-path, explicit-only:**

- **Path A (Lines 168-193):** Type arguments `recipe<State>(...)`
  - Uses TypeNode from `node.typeArguments` directly
  - No TypeRegistry registration (original source nodes)
- **Path B (Lines 196-243):** Parameter annotations
  `recipe((state: RecipeState) => ...)`
  - Uses `inputParam.type` if exists
  - **ONLY transforms if explicit annotation present** (line 223)
  - No TypeRegistry registration

#### Schema Generation

- Input schema only (no output)
- Preserves optional string name argument
- Order: `[...schemas, optionalName, function]`

#### Key Characteristics

- **Strictest path:** No inference, requires explicit types
- Falls back to no transformation if types missing
- Philosophy: "Recipes should be explicitly typed"

---

### 2. Pattern Transformation (Lines 246-313)

#### Type Source Strategy

**Hybrid with optional inference:**

- Uses `collectFunctionSchemaTypeNodes()` helper
- Explicit annotations preferred, falls back to inference
- Type arguments serve as **hints** for parameter inference (lines 262-268)

#### Schema Generation

- Both input and output optional
- **Unique ordering:** `[function, ...schemas]` - schemas AFTER function

#### Key Characteristics

- Most flexible: transforms with 0, 1, or 2 schemas
- Type arguments are hints, not requirements
- No TypeRegistry interaction

---

### 3. Handler Transformation (Lines 315-387)

#### Type Source Strategy

**CRITICAL: Dual-mode with synthetic types:**

**Mode A (Lines 320-354):** Type arguments `handler<Event, State>(...)`

- Uses TypeNodes from `node.typeArguments`
- **Checks TypeRegistry** for ClosureTransformer-registered Types (lines
  334-344)
- Enables synthetic types for captured variables

**Mode B (Lines 356-386):** Parameter annotations

- Uses `eventParam?.type` and `stateParam?.type`
- **Fallback to `unknown`** if missing (lines 367-370)
- No TypeRegistry registration

#### Schema Generation

- Event + State schemas prepended
- Order: `[eventSchema, stateSchema, fn]`

#### Key Characteristics

- **Most lenient:** Always transforms, uses `unknown` fallback
- **Only path (with derive) that checks TypeRegistry**
- Philosophy: "Event handlers are dynamic, accept unknown types"

---

### 4. Derive Transformation (Lines 389-494)

#### Type Source Strategy

**Most complex: Three-mode:**

**Mode A (Lines 411-436):** Type arguments

- Uses TypeNodes from `node.typeArguments`
- **Checks TypeRegistry** like handler (lines 422-428)

**Mode B (Lines 439-493):** Inferred from arguments

- **Special case:** Empty `{}` → `TypeLiteralNode([])` (lines 452-459)
- Input: `checker.getTypeAtLocation(firstArg)` (line 462)
- Output: From callback via `collectFunctionSchemaTypeNodes`

#### Schema Generation

- Arg + Result schemas prepended
- Order: `[argSchema, resSchema, source, callback]`

#### Key Characteristics

- Heavy inference from context
- Special handling for empty object literals
- Partial transformation OK (unknown for missing types)

---

### 5. Lift Transformation (Lines 496-559)

#### Type Source Strategy

**Two-mode, simpler:**

**Mode A (Lines 518-529):** Type arguments

- Uses TypeNodes from `node.typeArguments`
- **Explicitly passes `undefined` for type values** (lines 525-528)
- **NO TypeRegistry check** ← Key difference!

**Mode B (Lines 532-558):** Inferred from callback

- Uses `collectFunctionSchemaTypeNodes`
- Inferred types ARE registered (lines 553-555)

#### Schema Generation

- Arg + Result schemas prepended
- Order: `[argSchema, resSchema, callback]`

#### Key Characteristics

- **Does NOT interact with ClosureTransformer**
- Type arguments assumed to be "real" source types
- Philosophy: "Lift has no closures, no synthetic types"

---

## Consistency Analysis

### Consistent Patterns

1. All paths prefer explicit type annotations
2. Preserve original TypeNodes when available
3. Wrap types in `createToSchemaCall()`
4. Use visitor pattern with `ts.visitEachChild()`

### Inconsistencies

#### 1. TypeRegistry Usage (MAJOR INCONSISTENCY)

| Path        | Mode A Behavior                             | Why                                             |
| ----------- | ------------------------------------------- | ----------------------------------------------- |
| **Handler** | Checks TypeRegistry                         | Expects synthetic types from ClosureTransformer |
| **Derive**  | Checks TypeRegistry                         | Expects synthetic types from ClosureTransformer |
| **Lift**    | **Explicitly ignores** (passes `undefined`) | No closure processing expected                  |
| **Recipe**  | Never checks                                | Operates before/independent of closures         |
| **Pattern** | Never checks                                | Operates before/independent of closures         |

**Impact:** Handler/Derive are tightly coupled to ClosureTransformer; Lift
intentionally decoupled.

#### 2. Transformation Requirements

| Path    | Requirement             | Behavior if missing               |
| ------- | ----------------------- | --------------------------------- |
| Recipe  | Explicit types REQUIRED | No transformation                 |
| Pattern | Optional                | Transforms with 0-2 schemas       |
| Handler | Very lenient            | Always transforms, uses `unknown` |
| Derive  | At least one type       | Uses `unknown` for missing        |
| Lift    | At least one type       | Uses `unknown` for missing        |

**Impact:** Recipe is strictest, Handler is most lenient, others moderate.

#### 3. Type Inference Strategy

| Path    | Strategy                                     |
| ------- | -------------------------------------------- |
| Recipe  | User annotations ONLY (no inference)         |
| Pattern | Hybrid (annotations + inference with hints)  |
| Handler | Annotations or `unknown` (minimal inference) |
| Derive  | Heavy inference from arguments               |
| Lift    | Inference from function signature            |

#### 4. Special Cases

**Empty object `{}`:**

- **Derive only:** Creates `TypeLiteralNode([])` for sealed object schema
- **Others:** No special handling

**Why:** Derive commonly uses `derive({}, () => ...)` pattern.

#### 5. Argument Ordering

- **Recipe:** `[...schemas, optionalName, function]`
- **Pattern:** `[function, ...schemas]`
- **Handler/Derive/Lift:** `[...schemas, ...originalArgs]`

Each has different runtime signature requirements.

---

## Type Inference vs Explicit Types

### Decision Tree

```
Has explicit type arguments?
├─ YES → Use them as-is
│   ├─ Handler/Derive: Check TypeRegistry for ClosureTransformer types
│   └─ Lift: Don't check TypeRegistry
└─ NO → Different strategies:
    ├─ Recipe: Check parameter annotations, fail if missing
    ├─ Pattern: Infer with collectFunctionSchemaTypeNodes
    ├─ Handler: Use parameter annotations or unknown
    ├─ Derive: Infer from arguments + callback
    └─ Lift: Infer from callback
```

### collectFunctionSchemaTypeNodes() Helper

**Location:** Lines 17-99

**Used by:** Pattern, Derive Mode B, Lift Mode B

**Strategy:**

1. Parameter: Use `parameter.type` if exists, else infer with
   `inferParameterType()`
2. Return: Use `fn.type` if exists, else infer with `inferReturnType()`
3. Convert inferred Types to TypeNodes with `typeToSchemaTypeNode()`
4. Return both TypeNode and Type for registration

**Philosophy:** "Explicit first, infer second"

---

## Potential Issues

### 1. Lift's TypeRegistry Inconsistency

**Issue:** Lift explicitly avoids TypeRegistry in Mode A, but Handler/Derive
check it.

**Possible reasons:**

- Lift never has closure transformations (by design)
- Defensive against unnecessary lookups
- Type arguments always "real" source types

**Question:** Intentional design or oversight? What if ClosureTransformer ever
processes lift?

---

### 2. Recipe's Strictness vs Handler's Leniency

**Recipe:** Requires explicit types, won't transform otherwise

**Handler:** Always transforms, uses `unknown` fallback

**Impact:**

- Inconsistent UX: "Why does recipe need types but handler doesn't?"
- Different philosophies about type safety

**Possible justification:**

- Recipes are top-level definitions (should be well-typed)
- Handlers are event-driven (dynamic, `unknown` is valid)

---

### 3. Handler's Unknown Fallback

**Issue:** Handler creates `unknown` schemas when types missing (lines 367-370).

**Risks:**

- Masks type errors
- Runtime validation errors instead of compile-time
- Mismatch between TypeScript understanding and runtime

**Justification:**

- Event handlers often dynamic (user interactions)
- Better to have schema than no handler
- Runtime validation catches issues

---

### 4. Empty Object Literal Handling

**Only derive handles `{}` specially** (lines 452-459).

**Result:**

- `derive({}, ...)` → Sealed empty object schema
- `lift(() => {})` → Might infer differently

**Impact:** Inconsistent semantics for `{}` across functions

**Justification:** Derive commonly uses `derive({}, () => ...)` pattern

---

### 5. Type Parameter Instantiation

**Issue:** No explicit handling of uninstantiated generic type parameters.

**Check:** `isAnyOrUnknownType()` treats `TypeFlags.TypeParameter` like
`any`/`unknown`

**Problem:**

- Generic functions like `function test<T>(x: T) { derive(x, ...) }` might fail
- Silent failure (no error message)

**Current behavior:** Falls back to `unknown` or skips transformation

---

### 6. ClosureTransformer Coupling

**Issue:** Handler and Derive tightly coupled to ClosureTransformer via
TypeRegistry.

**Dependencies:**

- Transformer ordering critical
- Implicit contract between transformers
- Testing in isolation difficult

**Question:** Should dependency be more explicit (e.g., config flag)?

---

## Summary

**Most consistent:** All paths prefer explicit type annotations

**Most inconsistent:** TypeRegistry usage:

- Handler/Derive: Check and use
- Lift: Explicitly ignore
- Recipe/Pattern: Don't interact

**Conceptual split:**

- **Strict (Recipe):** Explicit types required
- **Lenient (Handler):** Accepts unknown
- **Inference-based (Derive):** Actively infers from context
- **Hybrid (Pattern, Lift):** Infer but can fail gracefully

**Handler is unique:**

- Most lenient (unknown fallback)
- Tightly coupled to ClosureTransformer
- Always transforms (others may skip)
- Makes sense for event handlers but creates inconsistency

**Key tension:**

- Type safety (require explicit) vs
- Developer experience (infer when possible) vs
- Runtime flexibility (accept unknown)

Each path made different tradeoffs based on use case.
