# Vendor fork

This directory is an adapted snapshot of Astral. It is not a byte-for-byte copy
of an upstream release.

The facts below were established by comparing Git trees and patches. Do not
infer the current divergence from an earlier version of this file.

## Provenance

| Item                | Commit                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Upstream repository | [`lino-levan/astral`](https://github.com/lino-levan/astral)                                                      |
| Upstream base       | [`90f952ae`](https://github.com/lino-levan/astral/commit/90f952ae76f36825b7af646b4d9f04f1dfd7c76b)               |
| Imported fork       | [`jsantell/astral@0a76c321`](https://github.com/jsantell/astral/commit/0a76c32100978d977247096bef0f9affe893cf05) |
| Labs import         | `65211e439`                                                                                                      |

The imported fork is one commit after the upstream base. It is not an ancestor
of upstream `main`.

The fork commit adds an optional `"pierce"` selector strategy to `Page` and
`ElementHandle`. The strategy searches through nested shadow roots. Its
production changes are in:

- `src/debug.ts`
- `src/element_handle.ts`
- `src/page.ts`
- `src/query.ts`

The fork also added `tests/shadow_query_test.ts`. The Labs import omitted that
test with the rest of the upstream test directory. Shell and pattern integration
tests and the shared presentation interaction helper exercise the `"pierce"`
strategy.

## Use in Common Tools

The root import map resolves `@astral/astral` to this directory. Current
consumers verified from source have three roles:

- `packages/deno-web-test` launches a browser, loads browser test modules,
  evaluates its test harness in the page, and relays browser console events.
- `packages/integration` wraps Astral's browser and page APIs for shell and
  pattern integration tests. It drives navigation, selectors, input, evaluation,
  screenshots, console and dialog handling, screencasts, and presentation
  recording.
- Developer tools use Astral to run the object-hashing benchmark in Chrome and
  use the generated Celestial protocol client to capture a CPU profile from a
  Deno inspector connection.

## Changes made while importing

The initial Labs import added this file and changed two copied files from the
fork commit:

- `deno.jsonc` removed `compilerOptions`, `lock: false`, and
  `unstable: ["worker-options"]`.
- `src/page.ts` removed the worker-specific `deno: { permissions }` option when
  creating the module worker used to query sandbox permissions.

The worker change means this copy cannot pass a custom Deno permission set to
that worker. Sandbox permission behavior must be rechecked when updating
`src/page.ts`.

The import copied the package implementation, generated protocol bindings,
workflows, license, and top-level readme. It omitted the complete upstream
`docs`, `examples`, and `tests` directories. At the imported fork commit, there
were 22 files under `docs`, 6 under `examples`, and 74 under `tests`.

## Common Tools changes after importing

### Browser interaction observation

Labs commit `fbed7dd681` adds browser interaction instrumentation used by
integration-test video recording:

- `Page` exposes `InteractionObserver` and `setInteractionObserver()`.
- Element clicks call optional `beforeClick` and `afterClick` observers.
- Element typing calls optional `beforeType` and `afterType` observers.
- Click and typing failures remain the reported error when an `after` observer
  also fails.
- `Keyboard` exposes `setDefaultTypeDelay()`. A per-call typing delay takes
  precedence over the default.

These changes modify `src/page.ts`, `src/element_handle.ts`, and
`src/keyboard/mod.ts`.

### Browser shutdown

Labs commit `bc162b0bea` changes `Browser.close()` in `src/browser.ts`. Closing
now tolerates the browser process exiting between the polite termination request
and the forced termination request. It still awaits the child process status.

### Browser cache coordination

Labs commit `37336e272` adds a regression test for two concurrent `getBinary()`
calls. It reproduces the former waiter's failure when the pinned standard
library rejected `Infinity` as a retry count.

Labs commit `a8e57261b` replaces the PID-file and retry-based cache lock in
`src/cache.ts`:

- A persistent `.astral.lock` file and an exclusive Deno file lock serialize all
  downloads and cleanup for one cache across processes.
- A downloader reloads `cache.json` after acquiring the lock, so it reuses a
  browser installed by the preceding lock holder.
- Cleanup returns without creating an absent cache. For an existing cache, it
  holds the same lock while deleting every other entry and retains the lock
  file.
- Directory aliases coordinate through the same physical lock file.
- The old process-local lock registry, PID files, retry loop, and retry timeout
  are removed. The `timeout` option remains accepted for call compatibility but
  no longer controls cache locking.

That commit adds `src/cache-lock.test.ts`. Together with `src/cache.test.ts`
from the regression commit, the tests cover concurrent downloads, cross-process
exclusion, cleanup ordering, directory aliases, cache-scoped filesystem
permissions, and absent-cache cleanup.

### Dependency constraints

Labs commit `c01dda1be7` changes the dependency constraints in `deno.jsonc`:

| Dependency        | Imported constraint | Current constraint |
| ----------------- | ------------------- | ------------------ |
| `@std/assert`     | `^1`                | `^1.0.19`          |
| `@std/async`      | `^1`                | `^1.5.0`           |
| `@std/fs`         | `^1`                | `^1.0.24`          |
| `@std/path`       | `^1`                | `^1.1.6`           |
| `@std/testing`    | `^1`                | `^1.0.19`          |
| `@std/encoding`   | `1`                 | `^1.0.11`          |
| `@zip-js/zip-js`  | `^2.7.52`           | `^2.8.31`          |
| `@deno/cache-dir` | `0.22.2`            | `0.27.0`           |

Within this package, Labs commit `b069e43aa` only updated references in this
file from `deno.json` to `deno.jsonc`.

## Current upstream divergence

This section was last audited on 2026-07-24. The upstream `main` tip was
[`3d30095e`](https://github.com/lino-levan/astral/commit/3d30095e87e6f788d5810146e06a40db5c9478f1).
Upstream declared version `0.5.6`; this copy declares version `0.5.3`.

Upstream `main` has eight commits after the common base. This copy retains the
separate, unmerged selector fork and the Common Tools changes listed above.

The audited trees had:

- 130 files in upstream.
- 32 files in this directory.
- 28 paths shared by both trees.
- 20 shared files that were byte-for-byte identical.
- 8 shared files with content differences.
- 4 files present only in this copy: `src/query.ts`, `src/cache.test.ts`,
  `src/cache-lock.test.ts`, and this file.
- 102 files present only in upstream because `docs`, `examples`, and `tests` are
  not vendored.

Ignoring the omitted upstream directories, the two local test files, and this
file, the production and configuration divergence covers nine files: eight
modified shared files plus `src/query.ts`.

| File                    | Source of divergence                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `deno.jsonc`            | Workspace adaptations, newer dependency constraints, the older declared package version, and missing upstream lint configuration. |
| `src/browser.ts`        | Common Tools browser-shutdown handling.                                                                                           |
| `src/cache.ts`          | Common Tools persistent file locking and missing upstream binary-path support.                                                    |
| `src/debug.ts`          | Selector-fork typing and missing upstream import-permission fallback.                                                             |
| `src/element_handle.ts` | Pierce selectors, interaction observation, and a missing upstream screenshot correction.                                          |
| `src/keyboard/mod.ts`   | Common Tools default typing delay.                                                                                                |
| `src/locator.ts`        | Missing upstream descendant-locator methods.                                                                                      |
| `src/page.ts`           | Pierce selectors, interaction observation, worker-option removal, and missing upstream import-permission enforcement.             |
| `src/query.ts`          | Selector-fork implementation; absent from upstream `main`.                                                                        |

The shared files that remained byte-for-byte identical were:

- `.github/workflows/ci.yml`
- `.github/workflows/publish.yml`
- `.gitignore`
- `LICENSE`
- `README.md`
- `bindings/README.md`
- `bindings/_tools/generate/addJSDoc.ts`
- `bindings/_tools/generate/getProtocol.ts`
- `bindings/_tools/generate/mod.ts`
- `bindings/celestial.ts`
- `mod.ts`
- `src/bin_args.ts`
- `src/coverage.ts`
- `src/dialog.ts`
- `src/file_chooser.ts`
- `src/interceptor.ts`
- `src/keyboard/layout.ts`
- `src/mouse.ts`
- `src/touchscreen.ts`
- `src/util.ts`

### Upstream changes not incorporated

The eight upstream commits after the common base include:

- [`02f6d9c`](https://github.com/lino-levan/astral/commit/02f6d9c947ada67470948b6a6e506100d025c51f)
  separates remote script imports from ordinary network access through Deno's
  `import` permission.
- [`6ee14fc`](https://github.com/lino-levan/astral/commit/6ee14fcf948072bdfbf94d9627c63fc847424eb3)
  supports `ASTRAL_BIN_PATH` as a browser-binary override.
- [`8bc945a`](https://github.com/lino-levan/astral/commit/8bc945a4d5b4fc831643ac4221701cfcc20aea67)
  adds descendant `locator()`, `$()`, and `$$()` methods to `Locator`.
- [`5d5d65f`](https://github.com/lino-levan/astral/commit/5d5d65f9be4bd3b63001211e3b3c04db8a7665a9)
  accounts for page scroll when taking an element screenshot.
- [`22ee8f6`](https://github.com/lino-levan/astral/commit/22ee8f6e6fc60310555637ec5b9ee7f979e355ac)
  replaces the invalid infinite retry count in the cache lock waiter with a
  finite value. This copy instead removes that waiter and uses an operating
  system file lock.
- Three version-only commits change the declared version from `0.5.3` through
  `0.5.6`.

## Updating the vendor copy

Treat an update as a three-way port from the upstream base, the selector fork,
and current upstream. Copying upstream over this directory would remove behavior
used by Labs.

An update must:

- Preserve the `"pierce"` selector API or migrate every Labs caller.
- Preserve the interaction-observer and default typing-delay APIs or migrate the
  integration video recorder.
- Reconcile the sandbox worker adaptation with upstream import-permission
  checks.
- Preserve the persistent cache file lock or replace it with equivalent
  cross-process coordination.
- Port applicable upstream binary-path, locator, and screenshot changes.
- Reconcile the declared version and dependency constraints deliberately.
- Run the local and applicable upstream package tests, the `deno-web-test`
  browser consumers, the shell and pattern browser integration suites, the
  presentation recorder tests, and checks for the benchmark and profiling entry
  points.
- Refresh the provenance, divergence counts, and upstream tip in this file.
