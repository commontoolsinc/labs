---
status: historical
created: 2026-08-14
archived: 2026-08-14
reason: "Investigation of why a plain `deno check` over the pattern corpus diverges from the environment patterns compile in, and the record of the fixes and gate changes that followed."
---

# Standalone type-checking of the pattern corpus

## What prompted this

Running a plain `deno check` over `packages/patterns/**/*.test.tsx` reported
twenty type errors, while the "CFC Pattern Check" CI job (`deno task cfcheck`)
and the pattern unit tests were green. The question was whether those twenty
errors were real defects the green jobs missed, or artifacts of the way
`deno check` sees pattern source. The answer turned out to be both, in
different proportions per error, and the split is the useful part of this
record.

## The two type environments

Pattern files are written in a dialect a TypeScript AST transformer rewrites
before the runtime evaluates them. Two commands type-check that source, and
they do not use the same environment.

- `deno task cfcheck` and `cf check <file>` type-check through the js-compiler
  (`packages/js-compiler/typescript/options.ts`): classic JSX with
  `jsxFactory: "h"`, and the runtime's own ambient type set. This is the
  environment a pattern actually compiles under. The transformer runs after
  type-checking, as a `before` emit transformer, so this check reads the
  authored source, not transformed output.
- `deno check` (via `tasks/check.sh`, driven by the repository `deno.jsonc`)
  uses the automatic JSX runtime — `jsx: "react-jsx"`,
  `jsxImportSource: "@commonfabric/html"` — and Deno's bundled standard
  library.

Both resolve `commonfabric` to the same `packages/api/index.ts` (the vendored
type set under `packages/static/assets/types/` is a set of symlinks back to the
live sources), so the divergence is not stale types. It is the JSX mode and the
standard library. Two facts follow from the JSX mode. Under classic JSX a JSX
expression is typed as whatever `h(...)` returns, a `VNode`; under automatic JSX
it is `JSX.Element`, which is the broader `JSXElement` union. And the classic-JSX
`h` typing accepts some children the automatic-JSX children contract rejects.

## The twenty errors, by cause

**Reserved `[UI]` typed `unknown` (2 errors, cfc-render-policy-demo).** The
demo's sub-patterns declared their reserved `[UI]` output as `unknown`. When a
pattern result is placed in JSX, the runtime renders it through `[UI]`, so under
automatic JSX the type system treats it as `UIRenderable`, whose `[UI]` must be a
`VNode`; `unknown` is not one. `VNode` is the correct type — at runtime the value
is always a `VNode`, the generated `$UI` schema becomes a proper vnode reference,
and nothing about how the pattern runs changes. It is nonetheless left as
`unknown` for now, blocked not by anything wrong with the type but by the
pattern-update compatibility gate. The demo's module defines the handler that
authorizes a trusted write (`revealSensitive`); the result schema records that
authorization as the module's content-addressed identity
(`ifc.writeAuthorizedBy.__ctWriterIdentityOf.moduleIdentity`), and the gate
compares the whole `ifc` for exact equality. Any edit to the module — this type
annotation, a comment, whitespace — rehashes it, so the identity changes and the
gate reads a recompile as a narrowed contract. A comment-only edit reproduces the
same "result.revealSensitive: ifc changed" failure, and a schema diff confirms
`moduleIdentity` is the only field that moves. Making the gate absorb a
recompile-only identity change is a separate piece of work; once it lands the
demo (and the nine other patterns carrying a CFC write) can take their correct
types. Until then the demo keeps `unknown`.

**Bare pattern factory as a JSX child (12 errors, cfc-trusted-component-
examples).** The galleries embedded each sub-gallery as `<div>{SendPublishExamples}
</div>` — the bare, uninstantiated factory. A factory is a function value; the
runtime never instantiates a function child, so it renders the function's source
text, and the reactive builder never wires the sub-pattern in. Automatic JSX
rejects this (a `PatternFactory` is not a `RenderNode`); classic JSX's looser `h`
typing lets it through. This is a real defect the standalone check caught and the
compile environment missed. Fixed by instantiating each sub-gallery at the render
site, which then exposed the same `[UI]: unknown` under-specification in the
sub-patterns whose result is rendered without a cast; those are typed `VNode`,
since they are inner patterns the update gate does not track. One gallery had to
be made renderable a different way — its default export gained the empty input
parameter its siblings carry — which changed its own contract compatibly, and its
new baseline was recorded.

**Writable scoped inputs with defaults (6 errors, scoped-group-chat/
main-with-writable-inputs).** This pattern types its inputs as
`PerSpace<Writable<Conversation | Default<…>>>` and reads into them with
`.key("rooms").map(...)`. Under `deno check` the body's view of the input cell
loses the top-level `Default` brand that `RequireDefaults` strips, while the
handlers it is passed to still declare the un-stripped cell type, and cell inner
types are invariant; separately, the automatic-JSX `.map` callback pollutes the
element type with JSX types so `room.name` stops resolving. The pattern compiles
and evaluates cleanly under `cf check`, and the sibling `main-plain-inputs.tsx`
(plain-data inputs, same logic) is clean under both checks. These six are
artifacts of the `deno check` environment — the classic-`h`/Deno-lib difference —
on correct code, not defects in the pattern. They were left as they are;
contorting a correct, working pattern to satisfy the environment it does not
compile under would not make anything more correct.

## Conclusion on the pattern corpus

`deno task cfcheck` is the authoritative standalone type-check for patterns: it
reads the authored source in the JSX and library environment the patterns
compile under. A `deno check` over pattern source is a second, mismatched lens.
It is worth keeping — it caught the bare-factory defect above that the compile
environment's looser JSX typing missed — but its extra errors are not all real.
The writable-scoped-inputs case is a false positive on correct code. The
`[UI]: unknown` case is a genuine under-specification the correct type would fix,
held back only by the update-gate limitation above, not by anything about the
type. Where the standalone lens disagrees with the compile environment,
`cfcheck` is authoritative.

## The `deno task check` coverage gap

Separately, `tasks/check.sh` — the single path list `deno task check`
type-checks — omitted whole workspace packages, so a green run was not evidence
the tree type-checks. Every workspace package is now named in the list, though a
few (`ui`, and the pattern corpus) stay partially covered by design. Two things
needed care. The `schema-generator` transformer fixtures do not compile
standalone (they name ambient wrappers the transformer supplies), so the list
takes `src` plus the real tests and leaves the fixtures out, as the
`ts-transformers` entry already does. And a package already in the batch pulls
Node's ambient types, which redefine the global timer functions so `setInterval`
returns a `Timeout` object rather than a `number`; a dashboard test that stored
an interval id in a `number` was corrected to `ReturnType<typeof setInterval>`,
which holds whatever the ambient library returns.

## Follow-up left open

The pattern-update compatibility gate freezes every pattern carrying a CFC
write. `assertPatternSchemasBackwardCompatible`
(`packages/piece/src/schema-compatibility.ts`) compares the result schema's
`ifc` for exact equality, and a `TrustedActionWrite` records its authorization
as the authoring module's content-addressed `moduleIdentity`. Any edit rehashes
the module, so the gate rejects it as a narrowed contract. Ten baselined
patterns are affected (`system/home`, `system/profile-*`, `lobby`, and the
`cfc-*` demos). The fix is to make the comparison tolerate a recompile-only
identity change while still comparing the binding (`file`, `path`) and the
`uiContract`; it is being done separately, and it is what unblocks the correct
`[UI]: VNode` type on the render-policy demo. The runtime write-verification
that consumes the real `moduleIdentity` at execution time is a different
mechanism and is not what this touches.

Separately, `packages/cf-harness/integration/engine.integration.test.ts` bounds
a subprocess with `setTimeout`. The type of the timer id was corrected here, but
the timeout itself is the kind of construct the repository's engineering
guidance says to remove rather than keep; that removal is a separate change.
