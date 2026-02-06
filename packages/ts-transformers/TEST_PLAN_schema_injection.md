# Comprehensive Test Plan: Schema Injection for Cell-like Objects

## Implementation Summary

This branch adds automatic schema injection for:

1. **Cell factory methods**: `cell()`, `Cell.of()`, `OpaqueCell.of()`,
   `Stream.of()`, etc.
2. **Cell.for() methods**: `Cell.for()`, `OpaqueCell.for()`, etc. (wrapped with
   `.asSchema()`)
3. **wish()**: Schema passed as second argument
4. **generateObject()**: Schema added to options object
5. **Literal type widening**: Number/string/boolean literals → base types

## Test Coverage Matrix

### 1. Cell Factory Tests (`cell()`, `*.of()`)

#### A. Type Argument Variations

**Happy Path:**

- [x] Explicit type arg with matching literal: `Cell.of<string>("hello")`
- [ ] Explicit type arg with variable: `Cell.of<string>(myVar)`
- [ ] Explicit type arg with expression: `Cell.of<number>(10 + 20)`
- [x] No type arg, infer from number literal: `cell(123)`
- [x] No type arg, infer from string literal: `cell("hello")`
- [x] No type arg, infer from boolean literal: `cell(true)`
- [ ] No type arg, infer from array literal: `cell([1, 2, 3])`
- [ ] No type arg, infer from object literal: `cell({ x: 10 })`
- [ ] No type arg, infer from function call result: `cell(getValue())`

**Edge Cases:**

- [ ] Type arg doesn't match value type: `Cell.of<string>(123)` (should use type
      arg)
- [ ] Complex generic type: `Cell.of<Array<{ id: number }>>(items)`
- [ ] Type with multiple generic params: `Cell.of<Map<string, number>>(map)`

#### B. All Cell-like Classes

**Coverage:**

- [x] `Cell.of()`
- [x] `OpaqueCell.of()`
- [x] `Stream.of()`
- [ ] `ComparableCell.of()`
- [ ] `ReadonlyCell.of()`
- [ ] `WriteonlyCell.of()`
- [ ] `cell()` function (standalone)

#### C. Value Type Variations

**Primitives:**

- [x] Number literal: `cell(42)`
- [x] String literal: `cell("test")`
- [x] Boolean literal: `cell(true)` and `cell(false)`
- [ ] BigInt literal: `cell(123n)`
- [ ] Null: `cell(null)`
- [ ] Undefined: `cell(undefined)`

**Collections:**

- [ ] Empty array: `cell([])`
- [ ] Array of primitives: `cell([1, 2, 3])`
- [ ] Array of objects: `cell([{id: 1}, {id: 2}])`
- [ ] Nested arrays: `cell([[1, 2], [3, 4]])`
- [ ] Tuple: `cell([1, "hello", true] as [number, string, boolean])`
- [ ] Empty object: `cell({})`
- [ ] Object with properties: `cell({ name: "test", age: 30 })`
- [ ] Nested objects: `cell({ user: { name: "test" } })`
- [ ] Array of mixed types: `cell([1, "two", true])`

**Complex Types:**

- [ ] Union type explicit: `cell<number | string>(42)`
- [ ] Union type inferred: `const val: number | string = getValue(); cell(val)`
- [ ] Optional type: `cell<string | undefined>("hello")`
- [ ] Intersection type: `cell<A & B>(value)`
- [ ] Enum value: `cell(MyEnum.Value)`
- [ ] Literal union: `cell<"a" | "b" | "c">("a")`
- [ ] Date: `cell(new Date())`
- [ ] RegExp: `cell(/pattern/)`
- [ ] Function: `cell(() => 42)`

#### D. Literal Widening Verification

**Number Literals:**

- [ ] Single literal: `cell(10)` → `{ type: "number" }` not
      `{ type: "number", enum: [10] }`
- [ ] Negative: `cell(-5)` → `{ type: "number" }`
- [ ] Float: `cell(3.14)` → `{ type: "number" }`
- [ ] Scientific notation: `cell(1e10)` → `{ type: "number" }`

**String Literals:**

- [ ] Simple string: `cell("hello")` → `{ type: "string" }` not enum
- [ ] Empty string: `cell("")` → `{ type: "string" }`
- [ ] String with escapes: `cell("hello\nworld")` → `{ type: "string" }`

**Boolean Literals:**

- [ ] True: `cell(true)` → `{ type: "boolean" }` not
      `{ type: "boolean", enum: [true] }`
- [ ] False: `cell(false)` → `{ type: "boolean" }` not enum

**Array Element Widening:**

- [ ] Array of number literals: `cell([1, 2, 3])` → items should be
      `{ type: "number" }`
- [ ] Array of string literals: `cell(["a", "b"])` → items should be
      `{ type: "string" }`

**Object Property Widening:**

- [ ] Object with literal properties: `cell({ x: 10, y: 20 })` → properties
      should be widened

#### E. Double-Injection Prevention

**Should NOT transform:**

- [ ] Already has 2 arguments: `cell(10, existingSchema)` → leave unchanged
- [ ] Already has schema in wrong position: `cell(schema, 10)` → should still
      not transform
- [ ] Has more than 2 arguments: `cell(10, schema, extra)` → leave unchanged

#### F. Context Variations

**Different scopes:**

- [ ] Top-level: `const c = cell(10);`
- [ ] Inside function: `function f() { const c = cell(10); }`
- [ ] Inside arrow function: `const f = () => { const c = cell(10); }`
- [ ] Inside class method: `class C { method() { const c = cell(10); } }`
- [ ] Inside recipe/pattern: `recipe(() => { const c = cell(10); })`
- [ ] Inside handler: `handler(() => { const c = cell(10); })`

---

### 2. Cell.for() Tests

#### A. Type Argument Variations

**Happy Path:**

- [x] Explicit type arg: `Cell.for<string>("cause")`
- [x] No type arg, infer from variable annotation:
      `const c: Cell<number> = Cell.for("cause")`
- [ ] No type arg, infer from parameter:
      `function f(c: Cell<string> = Cell.for("cause")) {}`
- [ ] No type arg, infer from return type:
      `function f(): Cell<number> { return Cell.for("cause"); }`

**Edge Cases:**

- [ ] Type inference failure (no contextual type): `const c = Cell.for("cause")`
      → what happens?
- [ ] Complex generic type: `const c: Cell<Array<T>> = Cell.for("cause")`

#### B. All Cell-like Classes

**Coverage:**

- [x] `Cell.for()`
- [ ] `OpaqueCell.for()`
- [ ] `Stream.for()`
- [ ] `ComparableCell.for()`
- [ ] `ReadonlyCell.for()`
- [ ] `WriteonlyCell.for()`

#### C. Wrapping Verification

**Format:**

- [ ] Verify output is `.asSchema()` method call:
      `Cell.for("x").asSchema(schema)`
- [ ] Verify original arguments preserved:
      `Cell.for("cause", arg2).asSchema(schema)`

#### D. Double-Wrapping Prevention

**Should NOT transform:**

- [ ] Already wrapped: `Cell.for("cause").asSchema(schema)` → leave unchanged
- [ ] Parent is property access to asSchema: verify detection works

---

### 3. wish() Tests

#### A. Type Argument Variations

**Happy Path:**

- [x] Explicit type arg: `wish<string>({ query: "query" })`
- [x] No type arg, infer from variable annotation:
      `const w: string = wish({ query: "query" })`
- [ ] No type arg, infer from parameter:
      `function f(w: number = wish({ query: "query" })) {}`
- [ ] No type arg, infer from return type:
      `function f(): string { return wish({ query: "query" }); }`
- [ ] Infer from WishResult wrapper:
      `const w: WishResult<T> = wish({ query: "query" })`

**Edge Cases:**

- [ ] Generic type: `wish<Array<User>>({ query: "query" })`
- [ ] Union type: `wish<string | number>({ query: "query" })`
- [ ] Complex nested type:
      `wish<{ users: User[], total: number }>({ query: "query" })`

#### B. Query Argument Variations

**Different query formats:**

- [ ] String literal: `wish<T>({ query: "simple query" })`
- [ ] Template literal: `wish<T>({ query: \`query with \${var}\` })`
- [ ] Variable: `const q = "query"; wish<T>({ query: q })`
- [ ] Expression: `wish<T>({ query: "prefix" + variable })`

#### C. Double-Injection Prevention

**Should NOT transform:**

- [ ] Already has 2 arguments: `wish<T>({ query: "query" }, schema)` → leave
      unchanged
- [ ] Has more than 2 arguments: `wish<T>({ query: "query" }, schema, extra)` →
      leave unchanged

---

### 4. generateObject() Tests

#### A. Type Argument Variations

**Happy Path:**

- [x] Explicit type arg with options:
      `generateObject<string>({ model: "gpt-4" })`
- [x] No type arg, infer from variable annotation:
      `const g: { object: number } = generateObject({ model: "gpt-4" })`
- [ ] No type arg, infer from return type
- [ ] No type arg, infer from parameter type

**Edge Cases:**

- [ ] Generic type: `generateObject<Array<T>>(...)`
- [ ] Complex nested type: `generateObject<{ users: User[] }>(...)`

#### B. Options Argument Variations

**Options formats:**

- [x] Object literal: `generateObject<T>({ model: "gpt-4" })`
- [ ] Empty object: `generateObject<T>({})`
- [ ] No options: `generateObject<T>()`
- [ ] Variable: `const opts = {...}; generateObject<T>(opts)`
- [ ] Spread in literal: `generateObject<T>({ ...baseOpts, model: "gpt-4" })`
- [ ] Expression: `generateObject<T>(getOptions())`

**Schema insertion:**

- [ ] Empty object → add schema: `{}` → `{ schema: ... }`
- [ ] Existing properties → add schema: `{ model: "x" }` →
      `{ model: "x", schema: ... }`
- [ ] Non-literal options → spread: `opts` → `{ ...opts, schema: ... }`

#### C. Double-Injection Prevention

**Should NOT transform:**

- [x] Already has schema in options:
      `generateObject<T>({ model: "x", schema: existingSchema })`
- [ ] Schema with different name (schemaDefinition, etc.) → should still inject
- [ ] Schema as computed property: `{ ["schema"]: existing }` → what happens?

---

### 5. Integration Tests

#### A. Multiple Functions Together

**Combinations:**

- [ ] Multiple cells in one scope: `const a = cell(1); const b = cell(2);`
- [ ] cell() + Cell.for(): Both get schemas correctly
- [ ] wish() + cell(): Both transformed
- [ ] generateObject() + cell(): Both transformed
- [ ] All four functions in one file

#### B. Nested in CommonTools Functions

**Contexts:**

- [ ] cell() inside recipe: `recipe(() => { const c = cell(10); })`
- [ ] cell() inside pattern: `pattern(() => { const c = cell(10); })`
- [ ] cell() inside handler: `handler(() => { const c = cell(10); })`
- [ ] cell() inside derive callback: `derive(x, () => { const c = cell(10); })`
- [ ] cell() inside lift callback: `lift(() => { const c = cell(10); })`

#### C. Closure Capture Interaction

**Verify no conflicts:**

- [ ] cell() in closure that's captured: Does schema injection work?
- [ ] cell() capturing another cell:
      `const a = cell(1); const b = derive(a, () => cell(2))`

---

### 6. Negative Tests (Should NOT Transform)

#### A. Missing Type Information

**Cases:**

- [ ] Type is `any`: `cell<any>(value)` → skip?
- [ ] Type is `unknown`: `cell<unknown>(value)` → skip?
- [ ] Type is `never`: `cell<never>(value)` → skip?
- [ ] Type inference fails completely → should not transform

#### B. Already Has Schema

**All formats:**

- [ ] `cell(value, schema)` → leave unchanged
- [ ] `Cell.for("x").asSchema(schema)` → leave unchanged
- [ ] `wish({ query: "query" }, schema)` → leave unchanged
- [ ] `generateObject({ schema })` → leave unchanged

#### C. Non-CommonTools Functions

**Should ignore:**

- [ ] Other library's `cell()`: `import { cell } from "other-lib";`
- [ ] User-defined cell(): `function cell(x) { return x; }`
- [ ] Similarly for wish, generateObject

---

### 7. Type System Edge Cases

#### A. Advanced TypeScript Features

**Complex types:**

- [ ] Conditional types: `cell<T extends string ? A : B>(value)`
- [ ] Mapped types: `cell<{ [K in keyof T]: T[K] }>(value)`
- [ ] Template literal types: `cell<\`prefix_\${string}\`>(value)`
- [ ] Indexed access: `cell<T[K]>(value)`
- [ ] `keyof` types: `cell<keyof T>(value)`
- [ ] `typeof` types: `cell<typeof value>(value)`

#### B. Generic Type Parameters

**In generic functions:**

- [ ] `function f<T>(val: T) { return cell(val); }` → how is T handled?
- [ ] `function f<T>() { return cell<T>(defaultValue); }`
- [ ] Constrained generics:
      `function f<T extends string>(val: T) { cell(val); }`

#### C. Type Aliases and Interfaces

**Indirection:**

- [ ] Type alias: `type X = number; cell<X>(10)`
- [ ] Interface: `interface I { x: number }; cell<I>({ x: 10 })`
- [ ] Nested type alias: `type X = Y; type Y = number; cell<X>(10)`

---

### 8. Schema Generation Verification

#### A. Schema Shape Correctness

**Verify schemas match JSON Schema spec:**

- [ ] Primitives have correct `type` field
- [ ] Objects have `properties` and `required`
- [ ] Arrays have `items`
- [ ] Unions use `anyOf` or appropriate construct
- [ ] All schemas have `as const satisfies __ctHelpers.JSONSchema`

#### B. Complex Schema Structures

**Advanced schemas:**

- [ ] Recursive types: `type Tree = { value: number, children: Tree[] }`
- [ ] Self-referential interfaces
- [ ] Mutually recursive types
- [ ] Very deeply nested structures (10+ levels)

---

### 9. Error Handling and Edge Cases

#### A. Malformed Code

**Should handle gracefully:**

- [ ] Syntax errors in surrounding code
- [ ] Incomplete type information
- [ ] Circular type references

#### B. Performance

**Large codebases:**

- [ ] File with 100+ cell() calls
- [ ] Very large type definitions (1000+ properties)
- [ ] Deeply nested generic types

---

### 10. Source Location Preservation

#### A. Formatting and Whitespace

**Verify:**

- [ ] Original formatting preserved where possible
- [ ] Line numbers stay consistent for error reporting
- [ ] Comments preserved
- [ ] Multi-line expressions handled correctly

---

## Test File Organization

Suggested new test files:

1. `test/schema-injection-cell-factory.test.ts` - Cell/cell() comprehensive
   tests
2. `test/schema-injection-cell-for.test.ts` - Cell.for() comprehensive tests
3. `test/schema-injection-wish.test.ts` - wish() comprehensive tests
4. `test/schema-injection-generate-object.test.ts` - generateObject()
   comprehensive tests
5. `test/schema-injection-literal-widening.test.ts` - Literal widening edge
   cases
6. `test/schema-injection-integration.test.ts` - Integration and combination
   tests
7. `test/schema-injection-negative.test.ts` - Negative cases and error handling

## Priority Levels

**P0 (Must Have):** Marked with [x] in matrix - basic happy path already covered
**P1 (High Priority):** Unmarked items in sections 1-4 (core functionality) **P2
(Medium Priority):** Sections 5-7 (integration, edge cases) **P3 (Nice to
Have):** Sections 8-10 (advanced features, performance)

## Test Implementation Strategy

1. Start with P1 tests for each function type
2. Add fixture-based tests for visual regression
3. Add unit tests for specific edge cases
4. Consider property-based testing for type system interactions
