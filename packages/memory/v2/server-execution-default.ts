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
 * value. `true` is the v2 posture — the first-party default since the
 * flip PR, which landed after the plan's Phase 7 ordered gates were met
 * (ON-skip registry EMPTY, OW31's ruled posture built, OW45–OW53 closed,
 * the OW38(ii) benchmark bar ruled met); `false` is the pre-flip behavior
 * byte-for-byte. An explicit `EXPERIMENTAL_SERVER_EXECUTION=true|false`
 * (or `experimental.serverExecution`) selects an arm regardless of this
 * value: an explicit `false` is the ROLLBACK LEVER (and CI's OFF
 * regression guard, run on an OFF-built binary) and stays selectable
 * through the post-flip soak. Un-flipping is reverting the flip PR (repo
 * convention: a flip is reverted by reverting the PR that only flips),
 * never a hand edit here; the flip PR changes this value AND the absolute
 * pin in
 * `packages/toolshed/lib/server-execution-flag.test.ts` (which states the
 * current default so a silent flip either way cannot hide behind
 * relative pins), the CI lane roles, and EXPERIMENTAL_OPTIONS.md together.
 * After the soak, the post-soak removal PR (Phase 7's split-out task)
 * retires the flag, the OFF path, and the OFF guard lanes.
 *
 * Deliberately a leaf module: the shell's main thread imports it without
 * pulling the wire-shape module (`../v2.ts`, which re-exports it).
 *
 * Single-process harnesses — a bare `new Runtime`, the `unitTest` /
 * `patternTest` / `localDev` presets — do NOT read this value: they have no
 * serving host, so they resolve the ambient baseline (OFF) by construction
 * (see the ambient flag in `../v2.ts`).
 */
export const SERVER_EXECUTION_DEFAULT_ENABLED = true;
