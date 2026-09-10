---
status: historical
created: 2026-08-17
archived: 2026-08-17
reason: "Investigation snapshot; the suspected CI coverage gap was disproved and the residue it exposed was fixed."
---

# Pattern-test CI coverage investigation

An investigation into whether the pattern tests (`packages/patterns/**/*.test.tsx`,
run by `cf test`) ever run in CI. The suspicion arose during pattern migration
work: `deno task cf test <file>` failed for any pattern importing across
directories, the compile-oriented lanes visibly exclude `*.test.tsx`, and no
workflow text mentions `cf test`.

## Finding: the corpus runs in CI, fully

The "Pattern Unit Tests" job in `.github/workflows/deno.yml` runs every
`.test.tsx` file under `packages/patterns` on every push and pull request:

- The job invokes `deno task integration --junit-dir=test-results
  pattern-tests <chunk>/5` with a prebuilt `cf` binary (`CF_BINARY`).
- The `pattern-tests` target (`runPatternTests` in `tasks/integration.ts`)
  walks `packages/patterns` for `**/*.test.tsx` with no exclusions and runs
  each file as `cf test --timeout 180000 --root packages/patterns <file>`,
  five files in flight, chunked five ways by an FNV-1a hash of the filename.
- On the then-latest green main run (32075577637, commit `751cbf75c`,
  2026-08-17), the five chunks found 32 + 24 + 23 + 17 + 24 = 120 files —
  exactly the corpus size at that commit — and passed all of them, including
  `factory-outputs/lot-watch/main.test.tsx` (46.9s) and
  `factory-outputs/parking-coordinator/main.test.tsx` (123.3s).
- The job gates merges (`status` and `coverage-check` depend on it) and is
  the sole source of authored-pattern coverage for the coverage ratchet
  (`docs/development/COVERAGE.md`).

Why the initial evidence pointed the other way:

- `tasks/pattern-files.ts` excludes `*.test.tsx` — correctly: that list feeds
  `cfcheck` and `pattern-compat`, the compile and updatability gates over
  deployable pattern entries, not the test lane.
- The `test` task in `packages/patterns/deno.jsonc` ignores `**/*.test.tsx` —
  deliberate lane routing, documented in that file's comment block: `.tsx`
  tests are patterns, runnable only by `cf test`, not `deno test`.
- Grepping workflows and tasks for `cf test` finds nothing because the
  workflow spells the lane `deno task integration … pattern-tests`, and
  `tasks/integration.ts` composes the command as `[...cfCmd, "test", …]`; the
  two words never appear adjacent in the tree.

## The residue that made a healthy lane look rotten

Bare `deno task cf test <file>` (no `--root`) failed for any pattern whose
imports climb out of its own directory, with an error naming a file that
exists in no source:

```text
✗ Error: No such file or directory (os error 2): realpath
  '…/factory-outputs/lot-watch/cfc/admin/mod.ts'
```

Mechanism: program source names are grounded absolute (`/main.test.tsx`), and
`resolveImportSpecifier` joined relative imports with a posix `join`, which
silently clamps `..` segments at the root. `../../cfc/admin/mod.ts` became
`/cfc/admin/mod.ts`, an in-root path that was then reported as missing — and
had the clamped path named a real file, the compile would have silently used
the wrong module. At the time roughly twenty directories under
`packages/patterns` held patterns with such package-spanning imports, so every
bare invocation of an affected test looked like rot. CI never saw this because
the lane always passes `--root packages/patterns`.

## Disposition

Fixed rather than documented around, in the change this report accompanies:

- The compile graph refuses an import that climbs above the program root,
  naming the import and the importer
  (`importEscapesProgramRoot` in `packages/js-compiler/specifier.ts`, applied
  in `typescript/resolver.ts`); `cf test` appends its `--root` hint to that
  refusal.
- `cf test` infers its default root as the nearest ancestor whose
  `deno.json(c)` declares a package name (`inferProgramRoot` in
  `packages/cli/lib/program-root.ts`), so a bare run anchors at
  `packages/patterns` — the root CI passes explicitly — and the invocation
  that prompted this investigation now passes. The `name` requirement is
  load-bearing: `packages/patterns/auth/deno.jsonc` is a nameless
  workspace-member stub whose directory must not capture the walk (its own
  test imports `../test/vnode-helpers.ts`).
- The invocation docs (`docs/common/workflows/pattern-testing.md`,
  `docs/common/ai/pattern-testing-guide.md`, `skills/pattern-test/SKILL.md`)
  now state the root rule.
