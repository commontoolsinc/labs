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
not install has its `declare var` removed from them, so a pattern that reaches
for it fails to compile rather than throwing a `TypeError` once deployed. The
names live in `SANDBOX_WITHHELD_GLOBALS`
(`packages/utils/src/sandbox-contract.ts`).

`compile-types` applies this on the way out, so a regenerated `es2023.d.ts`
already has them removed. After changing the list, run:

    deno task strip-withheld-globals

`deno task check-withheld-globals` fails when a checked-in library still
declares a withheld global, and
`packages/runner/test/sandbox-global-contract.test.ts` checks the libraries and
a real compartment against each other in both directions.

The names that still break this rule — the timers, `queueMicrotask` and `Intl` —
are listed in `SANDBOX_UNRESOLVED_GLOBAL_GAPS` next to the withheld list. The
same test pins that list to the gaps that actually exist, so it only shrinks.
