# @commonfabric/static

This is a package that abstracts away handling of lazy-loaded static assets in
both our Deno and browser environments. In Deno, the assets are loaded from
disk, and in browsers, rely on the host (`toolshed`) to serve assets at a
well-known route (`/static/*`).

## Building

To compile the types, you will need to have the `es2023.d.ts` file available
from the [TypeScript](https://github.com/microsoft/TypeScript) repository. The
task assumes that will be checked out with the same parent folder as `labs`.

## Withheld globals

`assets/types/es2023.d.ts` and `assets/types/dom.d.ts` describe the sandbox
patterns run in, not stock TypeScript. A global that the SES compartment does
not install has its declaration removed from them, so a pattern that reaches for
it fails to compile rather than throwing a `TypeError` once deployed. The names
live in `SANDBOX_WITHHELD_GLOBALS` (`packages/utils/src/sandbox-contract.ts`).

`compile-types` applies this on the way out, so a regenerated `es2023.d.ts`
already has them removed. After changing the list, run:

    deno task strip-withheld-globals

`deno task check-withheld-globals` fails when a checked-in library still
declares a withheld global, and
`packages/runner/test/sandbox-global-contract.test.ts` checks the libraries and
a real compartment against each other in both directions.

That test requires zero gaps: every global the compiler declares must be one the
compartment installs. A newly declared global that the compartment lacks fails
the test until it is endowed or added to the withheld list.

### Checks that run only in CI

Two things depend on this list that neither `deno task cfcheck` nor
`deno task check` catches, so a change that passes both locally can still fail
in CI:

- The `packages/ts-transformers` and `packages/schema-generator` fixture suites
  type-check their fixture inputs against the pattern type libraries, so a
  fixture that uses a now-withheld global stops compiling. `deno task cfcheck`
  only checks `packages/patterns`, and `deno task check` type-checks source;
  neither compiles those fixtures. After changing the withheld list or the type
  libraries, run `deno task test` in both packages, and regenerate the
  transformer goldens with `UPDATE_GOLDENS=1` (see
  `packages/ts-transformers/AGENTS.md`).
- The Performance Check job ratchets `packages/static` uncovered lines. New code
  in `scripts/strip-withheld-globals.ts` needs matching tests, or it trips the
  ratchet. Neither `cfcheck` nor `deno task check` measures coverage.
