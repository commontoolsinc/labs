/**
 * The ONE first-party default of the server-execution v2 flag
 * (`EXPERIMENTAL_SERVER_EXECUTION`; docs/specs/server-side-execution/,
 * docs/plans/server-execution-v2.md Phase 7 — the flip). Every
 * deployed-topology entry point resolves an UNSET flag to this value: the
 * `productionServer` / `remoteClient` construction presets
 * (`packages/runner/src/runtime-presets.ts`), toolshed's serving-host gate
 * and memory ACL principal lists (`packages/toolshed/lib/
 * server-execution.ts`; the DELEGATING class since OW31's build — never
 * an implicit-OWNER service grant),
 * and the browser shell's build-define fallback
 * (`packages/shell/src/lib/env.ts`), so flipping the default is this one
 * value. `false` is the pre-flip behavior byte-for-byte; `true` is the v2
 * posture. An explicit `EXPERIMENTAL_SERVER_EXECUTION=true|false` (or
 * `experimental.serverExecution`) selects an arm regardless of this value.
 *
 * LANDED DARK (owner ruling 2026-08-16, on the Phase 7 independent
 * review): the flip-ready mechanism landed with this constant `false` —
 * the OFF posture stays the default everywhere it reaches, the ON posture
 * stays fully selectable (CI's explicit-`true` lanes run it on an ON-built
 * binary). The flip to `true` is its OWN separate one-line PR (repo
 * convention: a flip is reverted by reverting the PR that only flips),
 * owed AFTER the ON posture works and is performant — the plan's Phase 7
 * task 1 records the ordered gates (client non-settling triage → OW17
 * re-keying → OW28 → the honest benchmark → then the flip). The flip PR
 * changes this value AND the absolute pin in
 * `packages/toolshed/lib/server-execution-flag.test.ts` (which states the
 * current default so a silent flip either way cannot hide behind
 * relative pins), the CI lane roles, and EXPERIMENTAL_OPTIONS.md together.
 *
 * Deliberately a leaf module: the shell's main thread imports it without
 * pulling the wire-shape module (`../v2.ts`, which re-exports it).
 *
 * Single-process harnesses — a bare `new Runtime`, the `unitTest` /
 * `patternTest` / `localDev` presets — do NOT read this value: they have no
 * serving host, so they resolve the ambient baseline (OFF) by construction
 * (see the ambient flag in `../v2.ts`).
 */
export const SERVER_EXECUTION_DEFAULT_ENABLED = false;
