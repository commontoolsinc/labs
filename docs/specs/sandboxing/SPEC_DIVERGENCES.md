# SES Sandboxing: Spec vs Implementation Divergences

> Generated 2026-01-29 from audit of `SES_SANDBOXING_SPEC.md` against the
> `feat/ses-based-sandboxing` branch.

## Status Key

- **Decide**: Needs discussion — update spec or change implementation?
- **Spec drift**: Spec describes something the implementation intentionally does differently
- **Not implemented**: Feature described in spec but not built yet
- **Dead code**: Code exists but is not wired into the execution path

---

## 1. Architecture: CompartmentManager vs SESIsolate

**Spec (Section 5)** envisions `CompartmentManager` as the core execution
path — loading patterns into cached Compartments with frozen exports, module
maps, and import hooks.

**Implementation** uses `SESIsolate`/`SESRuntime`
(`packages/runner/src/harness/ses-runtime.ts`) which creates bare Compartments
with no custom globals and relies on AMD loader injection. The
`CompartmentManager` (`packages/runner/src/sandbox/compartment-manager.ts`)
exists as standalone code but is **not used by the actual runtime execution
path**.

**Impact**: This is the most fundamental divergence. Everything downstream
(frozen exports, module maps, import hooks, pattern caching) follows from this
architectural choice.

**Status**: Decide

---

## 2. Lockdown Configuration

| Option | Spec (Section 5.1) | Implementation (`config.ts`) |
|---|---|---|
| `errorTaming` | `"unsafe"` (always) | `debug ? "unsafe" : "safe"` |
| `stackFiltering` | `"verbose"` (always) | `debug ? "verbose" : "concise"` |
| `overrideTaming` | `"moderate"` | `"severe"` |
| `consoleTaming` | `"unsafe"` | `"unsafe"` (matches) |
| `localeTaming` | `"unsafe"` | missing |
| `evalTaming` | `"safeEval"` | missing |
| `mathTaming` | not mentioned | `"unsafe"` (temporary relaxation) |
| `dateTaming` | not mentioned | `"unsafe"` (temporary relaxation) |

**Status**: Spec drift — update spec to match implementation choices

---

## 3. SandboxConfig Interface

**Spec (Section 8.6.4)** defines:
```typescript
interface SandboxConfig {
  errorDisplay: 'pattern-only' | 'full';
  isRuntimeDeveloper: boolean;
}
// Plus detectConfig() using process.env.COMMON_TOOLS_DEBUG
```

**Implementation** (`types.ts`):
```typescript
interface SandboxConfig {
  enabled: boolean;
  debug: boolean;
  console?: Console;
}
```

Completely different shape. No `errorDisplay`, no `isRuntimeDeveloper`, no
environment variable detection.

**Status**: Spec drift — update spec

---

## 4. Runtime Globals

**Spec (Section 5.2, Section 9 Phase 2.3)** describes a minimal set:
- Restricted `Object` (only `keys`, `values`, `entries`, `freeze`)
- Restricted `Array` (only `isArray`, `from`)
- `pattern`, `recipe`, `lift`, `handler`, `derive`, `Cell`, `cell`, `h`,
  `console`, `JSON`, `Math`

**Implementation** (`runtime-globals.ts`) provides:
- **Full** `Object`, `Array`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Promise`,
  `Error`, `TypeError`, `RangeError`, `SyntaxError`, `RegExp`, `Symbol`,
  `Proxy`, `Reflect`
- `Date`, `String`, `Number`, `Boolean`
- All TypedArrays, `ArrayBuffer`, `DataView`
- `parseInt`, `parseFloat`, `isNaN`, `isFinite`, URI encode/decode functions
- `fetch` (with deprecation warning)
- `harden`
- 30+ CommonTools-specific globals: `patternTool`, `action`, `computed`,
  `Writable`, `OpaqueCell`, `Stream`, `str`, `ifElse`, `when`, `unless`,
  `llm`, `generateObject`, `generateText`, `fetchData`, `navigateTo`, etc.

**Status**: Spec drift — the restricted-subset approach was abandoned in favor
of providing full globals. Update spec.

---

## 5. Module-Scope Validation Transformer

**Spec (Section 9, Phase 1.1)** describes a `ModuleScopeValidationTransformer`
that enforces an allowlist of permitted module-scope calls and rejects `let`/`var`
at module scope.

**Implementation**: No such transformer exists. The only module-scope
enforcement is the IIFE check in the existing transformer pipeline.

**Status**: Not implemented — decide if still needed

---

## 6. Export Name Annotation Transformer

**Spec (Section 4.4)** describes an `ExportNameAnnotationTransformer` that adds
`__exportName` annotations to module-scope builder calls, plus a `verifyFrozen()`
runtime check.

**Implementation**: Not implemented. `compartment-manager.ts` line 360
explicitly notes: "we don't need __exportName annotations."

**Status**: Not implemented — intentionally skipped. Update spec to remove.

---

## 7. Hoisting Trigger Condition

**Spec (Section 4.3)** describes hoisting as unconditional for `computed`,
`action`, and inline `derive` — always hoisted to module scope.

**Implementation** (`hoisting-transformer.ts`): Hoisting only occurs when
`referencesExternalSymbols()` returns true. Self-contained callbacks (no
external references) are left in place. The spec mentions this as an
"optimization" (Section 4.3.4) but the implementation uses it as the primary
gate.

**Status**: Spec drift — the optimization became the default. Update spec.

---

## 8. Import Hooks — Dead Code

**Spec (Section 6.2)** describes import hooks passed to the Compartment
constructor for dynamic `import()` support with URL allowlisting.

**Implementation** (`import-hooks.ts`): `createResolveHook()` and
`createImportHook()` exist with full implementation including `ESMCache`, but
they are **never connected** to any Compartment creation. Neither
`CompartmentManager` nor `SESIsolate` passes import hooks.

**Status**: Dead code — wire up or remove

---

## 9. FrozenExport / PatternCompartment Interfaces

**Spec (Section 5.2, 8.4.1)**:
```typescript
interface FrozenExport {
  __exportName: string;
  implementation: Function;
  inputSchema: JSONSchema;
  resultSchema: JSONSchema;
}
interface PatternCompartment {
  compartment: Compartment;
  exports: Map<string, FrozenExport>;
  sourceMap: SourceMap;
  sourceFiles: Map<string, string>;
}
```

**Implementation** (`types.ts`):
```typescript
interface FrozenExport {
  name: string;
  implementation: unknown;
  patternId: string;
}
interface PatternCompartment {
  patternId: string;
  exports: Map<string, FrozenExport>;
  getExport(name: string): FrozenExport | undefined;
}
```

Missing: `__exportName`, schemas, `compartment` instance, `sourceMap`,
`sourceFiles`.

**Status**: Spec drift — update spec to match simplified interfaces

---

## 10. Compartment Module Map

**Spec (Section 5.2)** shows runtime dependencies injected via a module map:
```js
compartment.evaluate(compiledAMD)({
  "@commontools/common-builder": harden(builderExports),
  "@commontools/common-html": harden(htmlExports),
});
```

**Implementation**: Compartments are created with empty module map `{}`.
Dependencies are provided as globals, not via module map. Source is wrapped in
an IIFE, not as an AMD factory receiving module imports.

**Status**: Decide — globals approach may be simpler and sufficient

---

## 11. Error Mapping Interface

**Spec (Section 8.4.2)**: `mapError()` is async, uses `SourceMapConsumer` from
the `source-map` library, returns `MappedError extends Error` with
`originalStack`, `mappedStack`, `mappedFrames`, `patternId`.

**Implementation** (`error-mapping.ts`): `mapError()` is synchronous, uses
`SourceMapParser` from `@commontools/js-compiler`, returns a plain
`MappedError` interface (not extending Error) with `originalError`,
`mappedStack`, `frames`, `patternLocation`, `userMessage`.

**Status**: Spec drift — update spec

---

## 12. Frame Classification

**Spec (Section 8.6.1)**: `FrameType = 'pattern' | 'runtime' | 'external'`
(3 types).

**Implementation** (`frame-classifier.ts`):
`FrameType = 'pattern' | 'runtime' | 'external' | 'ses'` (4 types).

**Status**: Spec drift — update spec to add `'ses'` type

---

## 13. Source Map Generation

**Spec (Section 8.3.2)** describes `HoistingTransformer` generating standard
source maps with `SourceMapGenerator.addMapping()`.

**Implementation** (`source-map-tracker.ts`): Only tracks hoisted declaration
positions. Does NOT produce VLQ-encoded source maps. Comments note "Phase 2
(future)" for standard source map support.

**Status**: Not implemented (Phase 2)

---

## 14. String Evaluation Wrapping

**Spec (Section 5.4)** describes wrapping as:
```js
`(function(__input__) { return (${code})(__input__); })`
```

**Implementation** (`compartment-manager.ts`): `evaluateStringSync()` evaluates
code directly with no wrapping. `wrapSourceForExports()` uses a different
pattern: `(function() { ${source} }).call({})`.

**Status**: Spec drift — update spec

---

## 15. Dynamic Import Compartment

**Spec (Section 9, Phase 4)** describes a `dynamic-import-compartment.ts` file
providing isolated dynamic imports with per-invocation module instances.

**Implementation**: No such file exists. The `ESMCache` in `import-hooks.ts`
has the caching logic but is not wired to any Compartment.

**Status**: Not implemented — related to #8 (dead code)

---

## 16. Runner Integration

**Spec (Section 9, Phase 3)** describes modifying `instantiateJavaScriptNode`
to use `CompartmentManager.getExport()` and `evaluateString()`, and removing
`UnsafeEvalIsolate`.

**Implementation**: The `SESRuntime`/`SESIsolate` is the actual integration
point but does not use `CompartmentManager`. The two architectures coexist but
are disconnected. Related to #1.

**Status**: Decide — part of the architectural question

---

## Priority Grouping

### Must decide (architectural)
- **#1** CompartmentManager vs SESIsolate
- **#10** Module map vs globals injection
- **#16** Runner integration path

### Update spec to match implementation
- **#2** Lockdown configuration
- **#3** SandboxConfig interface
- **#4** Runtime globals (full vs restricted)
- **#7** Hoisting trigger condition
- **#9** FrozenExport / PatternCompartment interfaces
- **#11** Error mapping interface
- **#12** Frame classification types
- **#14** String evaluation wrapping

### Decide: implement or remove from spec
- **#5** Module-scope validation transformer
- **#6** Export name annotation transformer
- **#8** Import hooks (dead code)
- **#15** Dynamic import compartment

### Deferred (future phases)
- **#13** Source map generation
