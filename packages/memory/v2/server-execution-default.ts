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
 * value. `false` is the pre-v2 behavior byte-for-byte; `true` is the v2
 * posture. An explicit `EXPERIMENTAL_SERVER_EXECUTION=true|false` (or
 * `experimental.serverExecution`) selects an arm regardless of this
 * value: an explicit `true` is how CI exercises the ON arm (on an
 * ON-built binary), and it stays selectable either way.
 *
 * ROLLED BACK (the flip-OFF lever, PR TBD-LEVER): the Phase 7 flip PR
 * (#6535) made this `true`; this PR is its minimal inverse — the default
 * returns to `false` and EVERY mechanism the flip PR built is KEPT: the
 * serving-side result carriage, the deployed-topology posture gates, the
 * CLI lane's client/server agreement probe, the arm-aware CLI and client
 * seams, and the two-arm lane architecture. Only what is COUPLED to which
 * arm is the default moves: this value, the absolute pin, the gates'
 * expected posture, and the CI lane roles (the explicit-arm guard lanes
 * become explicit-`true`, so the ON arm keeps a CI exercise while rolled
 * back). Reverting #6535 wholesale would have ripped the kept machinery
 * out with the default, which is why the rollback is a flip rather than a
 * revert — the repo convention that a flip is undone by reverting the
 * one-line flip PR assumes a PR that ONLY flips, and #6535 is not one.
 *
 * A flip in either direction changes this value AND the absolute pin in
 * `packages/toolshed/lib/server-execution-flag.test.ts` (which states the
 * current default so a silent flip either way cannot hide behind
 * relative pins), the CI lane roles, and EXPERIMENTAL_OPTIONS.md
 * together.
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
