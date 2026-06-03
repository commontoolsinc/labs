# CT-1661 trigger-condition confirmation

**Question (from Berni):** CT-1661 is a
`ModuleVerificationError: Top-level
mutable bindings are not allowed in SES mode`
triggered by a re-export live binding (`export { x } from "./sibling"`). Given
ESM is "not turned on yet," why did it occur? Does CT-1661 require
`esmModuleLoader` to be explicitly on?

**Verdict: YES — CT-1661 is latent.** It only fires when the ESM module-record
loader is enabled — either via `experimental: { esmModuleLoader: true }` OR via
the `CF_ESM_MODULE_LOADER=1`/`true` env var (both flip the same code path; see
`esm-loader-config.ts` `readEnvDefault`). Under today's default (loader off, env
unset) it does not trigger; the program compiles and runs correctly. It was surfaced only because the test
`packages/runner/test/wish-profile-car.test.ts` (modeled on
`esm-pattern-run.test.ts`) sets `experimental: { esmModuleLoader: true }`.

## Per-config empirical outcomes

Minimal 2-file `RuntimeProgram` (`/sibling.ts: export const thatConst = 42;` and
`/main.tsx: export { thatConst } from "./sibling.ts";` + a `lift`-based default
pattern), run through `compilePattern` + `run` + `getAsQueryResult`:

| Config                                                        | Effective `esmModuleLoader` | Outcome                                                                                                                         |
| ------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| (a) `experimental: { esmModuleLoader: true }`                 | `true`                      | **ModuleVerificationError: cf:module/<hash>:18:1: Top-level mutable bindings are not allowed in SES mode** (CT-1661 reproduced) |
| (b) no experimental flag (current default)                    | `false`                     | **OK** — `{ "result": 6 }`                                                                                                      |
| (c) `experimental: { esmModuleLoader: false }` (explicit off) | `false`                     | **OK** — `{ "result": 6 }`                                                                                                      |

(b) and (c) are identical: the default and the explicit-off behave the same.

## Current default of `esmModuleLoader` on this branch (post-rebase)

**Default: OFF.**

- `packages/runner/src/runtime.ts:335` — constructor seeds
  `esmModuleLoader: undefined` in `this.experimental`.
- `packages/runner/src/runtime.ts:362-363` — calls
  `setEsmModuleLoaderConfig(this.experimental.esmModuleLoader)` then reads back
  `getEsmModuleLoaderConfig()`.
- `packages/runner/src/sandbox/esm-loader-config.ts:14-24,35-37` — with no
  explicit option, the effective value falls back to `readEnvDefault()`, which
  reads `CF_ESM_MODULE_LOADER` and returns `false` unless it is `"1"`/`"true"`.
  The env var is unset in production, so the **production default stays OFF**
  (confirmed by the file's own doc comment, lines 8-11: "The production default
  stays OFF... this is NOT the flag flip").
- Empirically confirmed: in config (b) the runtime logged
  `effective esmModuleLoader = false`.

## Why it is latent (the two compile paths)

Two distinct compile/verify paths exist, selected by the flag:

- **Default (flag off):** `PatternManager.compilePattern` does NOT take the ESM
  branch (`pattern-manager.ts:528-529` requires
  `experimental.esmModuleLoader === true`). It uses the AMD harness `compile()`
  which bundles all files into one CommonJS script with `bundleExportAll: true`
  (`harness/engine.ts:242`) and verifies it with
  `CompiledBundleValidator.verify` (`harness/engine.ts:259`). Bundling collapses
  the sibling re-export into a single module, so there is no cross-module
  top-level live binding — the SES "mutable binding" check has nothing to flag.
- **Flag on (ESM record graph):** `compilePattern` routes to
  `harness.compileToRecordGraph` (`pattern-manager.ts:530-540`), which keeps
  each file as a separate content-addressed module record and runs
  `verifyModuleGraph` (`harness/engine.ts:425`, from
  `sandbox/module-record-verifier.ts`). The `export { x } from "./sibling"`
  re-export creates a top-level mutable live binding across records, which the
  SES verifier (`compiled-bundle-verifier.ts:526`) rejects with "Top-level
  mutable bindings are not allowed in SES mode."

So the SES per-record verifier that produces CT-1661 simply does not run on the
default path. There is no non-flag path that triggers it.

## `cf check` behavior

`cf check` on the same `main.tsx` (placed inside the repo root) passes clean in
every mode tested — it uses the AMD `compile()` path, not the ESM record graph:

- `deno task cf check ./main.tsx` (with run) → **clean**, exit 0.
- `deno task cf check ./main.tsx --no-run` → **clean**, exit 0.
- `CF_ESM_MODULE_LOADER=1 deno task cf check ./main.tsx` → still **clean**,
  exit 0. (The CLI `check` compile path does not invoke
  `compilePattern`/`compileToRecordGraph`, so even the env-seeded ESM default
  does not make `cf check` exercise the per-record SES verifier.)

`cf check` therefore does NOT catch CT-1661, and equally does not false-positive
on this re-export under normal use.

## One-paragraph answer for Berni

You're right that ESM isn't on yet, and that's exactly why this is safe today.
CT-1661 only reproduces when `esmModuleLoader` is explicitly turned on
(`experimental: { esmModuleLoader: true }`), which the `wish-profile-car` test
sets manually to exercise the new ESM module-record loader. On main right now
the flag defaults OFF (seeded `undefined` in `runtime.ts:335`, falling back to
the unset `CF_ESM_MODULE_LOADER` env var via `esm-loader-config.ts`, so the
production default is `false`). Under that default loader the same re-export
program compiles and runs fine (`{ result: 6 }`), because the AMD path bundles
all files into one module and never invokes the per-record SES verifier that
raises the error. `cf check` likewise passes clean (with and without `--no-run`,
and even with `CF_ESM_MODULE_LOADER=1`). So CT-1661 is a latent issue in the ESM
loader work, surfaced only by manually enabling the flag — it is not something
hit in normal operation today, and it stays safe until the default is flipped.
