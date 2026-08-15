/**
 * The ONE first-party default of the server-execution v2 flag
 * (`EXPERIMENTAL_SERVER_EXECUTION`; docs/specs/server-side-execution/,
 * docs/plans/server-execution-v2.md Phase 7 — the flip). Every
 * deployed-topology entry point resolves an UNSET flag to this value: the
 * `productionServer` / `remoteClient` construction presets
 * (`packages/runner/src/runtime-presets.ts`), toolshed's serving-host gate
 * and service-principal grant (`packages/toolshed/lib/server-execution.ts`),
 * and the browser shell's build-define fallback
 * (`packages/shell/src/lib/env.ts`), so flipping the default is this one
 * value. `false` is the pre-flip behavior byte-for-byte; `true` is the v2
 * posture — the Phase 7 flip (2026-08-15). An explicit
 * `EXPERIMENTAL_SERVER_EXECUTION=false` (or `experimental.serverExecution:
 * false`) selects the OFF arm regardless of this value — the rollback lever
 * until the OFF path is removed.
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
