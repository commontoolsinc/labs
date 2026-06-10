# Bug verification: MyCar wish/profile runner findings

Skeptical, repro-driven verification of two candidate findings that surfaced
while building `packages/runner/test/wish-profile-car.test.ts` (compiles
`packages/patterns/my-car/main.tsx` under `experimental.esmModuleLoader: true`
and runs it). Working reference: `packages/runner/test/esm-pattern-run.test.ts`.

Both repros were built as throwaway tests under `packages/runner/test/` and run
with `deno test --allow-all <file>`; they have since been deleted. The exact
code is inlined below so they can be recreated verbatim.

---

## FINDING 1 — SES rejects `export { x } from "./sibling"` re-export live bindings

**Verdict: REAL-BUG** (narrow, low-severity; the genuine defect is the
_detection gap_, not that SES forbids the form).

### Minimal repro

Two-file program, run under `esmModuleLoader: true`, growing `esm-pattern-run`'s
harness. `/sibling.ts`:

```ts
export const thatConst = 42;
export type Foo = { a: number };
```

Four `/main.tsx` variants, each `compilePattern` + `run` + `getAsQueryResult()`:

| Variant                 | main.tsx top-level line                                           | Result          |
| ----------------------- | ----------------------------------------------------------------- | --------------- |
| (a) re-export from      | `export { thatConst } from './sibling.ts';`                       | **THROWS**      |
| (b) import-then-export  | `import { thatConst } from './sibling.ts'; export { thatConst };` | OK `{result:6}` |
| (c) type-only re-export | `export type { Foo } from './sibling.ts';`                        | OK `{result:6}` |
| (d) local export const  | `export const localConst = 7;`                                    | OK `{result:6}` |

Each main also has `const dbl = lift((x:number)=>x*2);` and
`export default pattern<{value:number}>(({value}) => ({ result: dbl(value) }))`.

Observed for (a):

```
ModuleVerificationError: cf:module/<hash>:18:1:
Top-level mutable bindings are not allowed in SES mode
    at verificationErrorAt (packages/runner/src/sandbox/compiled-bundle-verifier.ts:1835:10)
```

This exactly reproduces the original MyCar symptom.

### Root cause

- `compileToRecordGraph` emits per-module **CommonJS**
  (`packages/js-compiler/typescript/compiler.ts:323`,
  `tsOptions.module = ts.ModuleKind.CommonJS`).
- For `export { x } from "./mod"`, TypeScript's CommonJS emit produces a **live
  getter binding** (`Object.defineProperty(exports, "x", { get () {...} })` / an
  exported `let`-style live binding) so the re-export tracks the source.
- The SES compiled-bundle verifier (`compiled-bundle-verifier.ts:507-528`,
  `verifyVariableStatement`) rejects any top-level binding whose kind is not
  `const`, throwing "Top-level mutable bindings are not allowed in SES mode".
- The `import { x } from …; export { x };` form (b) instead emits a plain
  one-time `exports.x = mod_1.x` assignment (no live binding), so it passes.
  Type-only re-export (c) is erased. Local `const` (d) is fine.

So only the live-binding **`export … from`** re-export form trips it. This is
the same class of "module-namespace live binding" issue addressed by CT-1623 /
PR #3797 ("walk module-namespace live bindings for verified-value graphs"); that
fix taught the verified-value graph to follow live bindings but did **not**
relax / pre-flight the SES top-level-mutable-binding check for authored
re-exports.

### The actual defect: the detection gap

`deno task cf check <pattern>` does **not** run the SES module verifier:

- `cf check .../main.tsx --no-run` → exit 0, no diagnostic.
- `cf check .../main.tsx` (with run) → exit 0, no diagnostic.
- Only `runtime.run(...)` under `esmModuleLoader: true` throws.

`--show-transformed` confirms the re-export passes through the cf transformer
verbatim (`export { thatConst } from "./sibling.ts";`); the rejection is purely
the runtime SES bundle verifier, which `cf check` never invokes.

This is the real problem: a pattern author writes legal ESM, `cf check` passes,
and the pattern only explodes at ESM-loader runtime with an opaque, hash-named,
authored-line-less error (`cf:module/<hash>:18:1`). That mismatch is what cost
MyCar debugging time.

### Recommendation: FILE (low severity, detection-gap framing)

Re-exporting from a sibling is legal, idiomatic ESM and a natural barrel-file
move; SES forbidding the live-binding form is defensible, but it must be caught
at authoring time with an authored-source location, not at run time with a hash
location. The cheap, high-value fix is detection parity, not loosening SES.

Draft ticket title: **"`cf check` passes patterns that fail SES at ESM-loader
runtime: re-export live bindings (`export { x } from './m'`) rejected only at
`runtime.run`, with opaque `cf:module/<hash>` location"**

Asks: (1) run the SES bundle/module verifier (or an equivalent lint) during
`cf check` so re-export live bindings are caught pre-run; (2) map the
`ModuleVerificationError` location back to authored file:line; (3) emit an
actionable hint ("re-export live bindings aren't allowed under SES — use
`import { x } from './m'; export { x };` or have consumers import from './m'
directly"). Reference CT-1623 / PR #3797 / #3832 and the MyCar workaround commit
`eacda89c6`.

---

## FINDING 2 — compiled pattern output "not materializing" (CFC field → `undefined`)

**Verdict: MY-MISUSE** (the underlying CFC rejection is by-design; the only mild
platform nit is error-surfacing, noted below).

### Incremental growth toward MyCar's shape

Single-file patterns, `esm-pattern-run` harness, `{}` input,
`getAsQueryResult()` after `pull()`:

| Step                          | Output shape                         | `getAsQueryResult()`                              |
| ----------------------------- | ------------------------------------ | ------------------------------------------------- |
| (1) plain fields + `[NAME]`   | `{[NAME], a, b, c}`                  | OK — full object                                  |
| (2) add `[UI]`                | `{[NAME], a, [UI]:<div>}`            | OK — full object incl. `$UI` vnode                |
| (3) Stream output (handler)   | `{[NAME], items, add: add({items})}` | OK — `add` is a stream link, `items` materializes |
| (5) `generateObject` in body  | `{[NAME], a, pending}`               | OK — `{pending:false}`                            |
| (4) owner-protected CFC field | `{[NAME], a, claims, addClaim}`      | **`undefined`** (whole result)                    |

Narrowing (4): each of `WriteAuthorizedBy<…>`, `Cfc<…,{ownerPrincipal}>`, and
`RepresentsCurrentUser<…>` **alone** also yields `undefined` for the _entire_
query result (not just the wrapped field) — `[NAME]` and `a:1` vanish too. That
"whole result gone" signal is the tell: it is not field-level projection, it is
an **aborted commit**.

### Root cause — confirmed by reading the commit result

My original harness called `await tx.commit()` and ignored its return. Passing
the pattern's `resultSchema` to the result cell and inspecting the commit:

```
resultSchema.claims.ifc = {
  ownerPrincipal: { __ctCurrentPrincipal: true },
  addIntegrity: [{ kind: "represents-principal",
                   subject: { __ctCurrentPrincipal: true } }]
}

commit error: StorageTransactionAborted —
"CFC enforcement rejected commit: relevant transaction was not prepared:
 ownerPrincipal requires writeAuthorizedBy at /claims"
```

The CFC type wrappers attach an `ifc` marker to the field's schema. Committing a
write to an owner-protected field requires the full CFC ceremony that
`packages/runner/test/profile-owner-cfc.test.ts` performs:

- `tx.setCfcTrustSnapshot({ id, actingPrincipal })`
- `tx.setCfcImplementationIdentity({ kind:"builtin", builtinId })` matching the
  field's `writeAuthorizedBy` handler
- recorded trusted edits /
  `recordCfcWritePolicyInput({claim:"runtime.setup.result-projection", …})`
- `tx.prepareCfc()` before `commit()`

Without that, CFC enforcement aborts the _whole transaction_, so the result cell
is never written and `getAsQueryResult()` is `undefined`. Steps (1)/(2)/(3)/(5)
have no `ifc` field, so their commits succeed and they materialize fine.

### Correct way to read run-pattern output (confirmed)

- `getAsQueryResult()` after `await result.pull()` is correct and works for
  plain fields, `[UI]`, and streams (streams appear as link objects, which is
  expected — read the target cell to drive/observe them).
- For CFC/owner-protected output you must (a) give the result cell the pattern's
  `resultSchema`, and (b) supply the CFC trust context + `prepareCfc()` before
  commit, and (c) **check `commit()`'s return for `.error`** — the abort is
  reported there, not by the read.

### Recommendation: DO NOT FILE as a materialization bug

Finding 2 is harness misuse: the missing CFC preparation made the commit abort,
and the abort (correctly) prevented any output from persisting. The platform
behaved as designed and even reported the precise reason ("ownerPrincipal
requires writeAuthorizedBy at /claims") — my harness threw that away by not
inspecting `commit()`.

Optional, low-priority follow-up (only if desired): a developer-experience nit
that `runtime.run` + ignored `commit()` silently yields `undefined` rather than
the run/test harness surfacing the swallowed `StorageTransactionAborted`. Not a
correctness defect; not recommended as a standalone ticket.

For the `wish-profile-car.test.ts` work itself, the fix is to mirror
`profile-owner-cfc.test.ts`: pass `resultSchema`, set the trust snapshot +
implementation identity for `addClaim`, and assert on `commit().error`.
