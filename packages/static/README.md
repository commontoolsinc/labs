# @commontools/static

This is a package that abstracts away handling of lazy-loaded static assets in
both our Deno and browser environments. In Deno, the assets are loaded from
disk, and in browsers, rely on the host (`toolshed`) to serve assets at a
well-known route (`/static/*`).

## Building

To compile the types, you will need to have the `es2023.d.ts` file available
from the [TypeScript](https://github.com/microsoft/TypeScript) repository. The
task assumes that will be checked out with the same parent folder as `labs`.
