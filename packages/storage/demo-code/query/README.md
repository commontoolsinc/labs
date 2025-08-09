# Reactive, Link-Aware Query Engine (Prototype)

This directory contains prototype code for a reactive, link-aware query engine.
It is intended for exploration and experimentation, not production use.

Key caveats:

- Uses an in-memory stub storage (`InMemoryStorage`) instead of the project's
  real storage layer.
- Internal types and conventions differ from the rest of the codebase (e.g.,
  path tokens, IR pool types). They will not align with production modules
  without changes.

If you want to try this out in the project:

- Replace `Storage` usage with the real storage implementation.
- Adjust path handling and link semantics to match the production storage
  conventions.
- Update types across modules (`types.ts`, `ir.ts`, `eval.ts`, etc.) to align
  with project interfaces.

Optional local usage:

- Demo: see `demo.ts` (exports a `demo()` function).
- Tests in this folder can be run directly with:
  - `deno test -A packages/storage/demo-code/query`

Again, this is prototype code. Expect to adapt it substantially before using it
anywhere outside of demos or experiments.
