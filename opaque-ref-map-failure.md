**OpaqueRef Map Alias Failure – State & Fix Plan**

_Last updated 2025-09-18_

---

### What Failed

When we ran `deno task integration`, the `default-app` recipe crashed with:

```
ReferenceError: commontools_1 is not defined
```

Every stack trace pointed to a `derive(...)` call inside an OpaqueRef `.map`
callback. That callback had been emitted by the modular transformer, stringified
into the recipe graph, and later re-evaluated by the runtime harness. Once the
function was rehydrated, its body still referenced `commontools_1.derive`, but
there was no longer any binding called `commontools_1`, so the first invocation
exploded.

The same shape exists in other patterns (e.g. `charms-ref-in-cell.tsx`); it just
remained latent because those recipes start with empty arrays. As soon as you
pre-seed the list and force the callback to run, you hit the identical
ReferenceError.

---

### How the Pipeline Gets There

1. **TypeScript → AMD bundles.** Each pattern which imports `commontools`
   becomes an AMD `define(...)` with the dependency array
   `["require", "exports", "commontools", ...]`; the third parameter in the
   factory is named `commontools_1`. The emitted JS refers to helpers as
   `(0, commontools_1.derive)(…)`, `(0, commontools_1.h)(…)`, etc.

2. **Modular transformer rewrites.** Our OpaqueRef rewrite uses the _checker_ to
   reuse that alias: it emits property accesses against whichever identifier
   `getCommonToolsModuleAlias` finds. If the compiled file imports
   `commontools`, we generate more `commontools_1.*` occurrences. If it doesn’t,
   we still emit `commontools_1`, producing dead code.

3. **Recipe graph serialisation.** During `recipe(...)`, the runtime traverses
   the output tree. Whenever it encounters a JavaScript function (including the
   little arrow created for `.map`), it captures only the source string via
   `fn.toString()`. That source contains `commontools_1.derive(...)`.

4. **Runtime rehydration.** Later, `packages/runner/src/harness/engine.ts` turns
   the string back into a function with `eval`. It keeps no memo of the original
   AMD closure, so there is no `commontools_1` binding in scope. If the callback
   happens to run (which `default-app` does immediately), we fall over.

---

### What’s Wrong Today

- **Alias name guessing.** The transformer depends on whatever alias the
  compiler happened to pick (`commontools_1`, `commontools_2`, …). That’s
  fragile and fails outright if the source never imported the module (because we
  injected `derive` ourselves).

- **Functions lose their environment.** Serialising map callbacks to
  `(0, commontools_1.derive)` and then `eval`-ing them later removes all lexical
  bindings. We got lucky that our rewrites also produce separate handler
  modules, but whenever a callback refers to the alias itself it now references
  a non-existent name.

- **Coverage blind spot.** Other patterns already emit the same shape but stay
  silent only because their lists are initially empty. As soon as real data
  arrives, they hit the same crash.

- **Show-transformed output confusion.** The concatenated “show transformed”
  view mixes several files together, making it easy to miss that each AMD module
  still declares its own alias; that’s how we ended up assuming the alias
  existed at runtime.

---

### Design for a Robust Fix

We need to stop depending on that ambient `commontools_1` symbol and give the
runtime enough information to construct safe helpers whenever it rehydrates a
`javascript` module.

**1. Track which helpers were used.**

- The OpaqueRef rewrite already produces a `helpers` set (`derive`, `ifElse`,
  etc.). Thread that metadata through the transformer so that when we create the
  `recipe("mapping function", …)` we annotate the resulting module (e.g.
  `module.helpers = ["derive"]`).

**2. Serialise helpers alongside the function body.**

- When `moduleToJSON` emits a `type: "javascript"` module, include those helper
  names in the JSON (e.g.
  `{ implementation: "...", helpers: ["derive","ifElse"] }`). Non-helper
  functions can omit the field.

**3. Rehydrate with explicit bindings.**

- In `engine.getInvocation` (and any other site that `eval`s module strings)
  wrap the source in a small factory that reintroduces the helpers:

  ```ts
  const runtimeCommontools = runtimeExports.commontools;
  const helperLines = helpers.map(
    (name) => `const ${name} = runtimeCommontools.${name};`,
  );
  const factory = new Function(
    "runtimeCommontools",
    `${helperLines.join("\n")} return (${source});`,
  );
  return factory(runtimeCommontools);
  ```

  Keep the original source untouched so other lexical captures (e.g. handler
  references) remain intact. If we see fully-qualified aliases
  (`commontools_1.derive`) in legacy strings, we can optionally build
  compatibility shims: declare a synthetic `commontools_1` object that delegates
  to the same `runtimeCommontools`.

**4. Stop emitting alias-specific property accesses.**

- Update the transformer so `createDeriveIdentifier` no longer digs for
  `commontools_1`. Instead, request imports through the existing `ImportManager`
  (so source files still get proper TypeScript imports) and emit **bare
  identifiers** (`derive(node, ...)`). Those plain names line up with the
  helpers we inject at runtime and avoid alias drift across nested modules.

**5. Lock in tests.**

- Add fixture coverage that:

  - Runs `deno task ct dev --no-run --output …` for a recipe with seeded data.
  - Loads the emitted bundle via the runtime harness and asserts that `.map`
    callbacks execute without throwing.
  - Verifies that helper metadata survives round-trips through JSON
    serialisation.

---

### Benefits

- **Resolves the integration failure** for `default-app` and any pre-seeded
  list.
- **Future-proofs** transformer output—even if TypeScript changes alias names or
  users omit a manual `commontools` import, helpers are still bound.
- **Keeps the runtime honest** about function dependencies instead of relying on
  ambient aliases.
- **Provides a clear extension point**: if other helpers (e.g. `lift`,
  `navigateTo`) need injection, they ride the same metadata.

---

### Next Steps

1. Plumb helper metadata through the transformer, recipe builder, and
   serialiser.
2. Implement the rehydration wrapper in `engine.getInvocation` (and anywhere
   else we eval module strings).
3. Update the transformer to emit bare helper names and request imports via
   `ImportManager`.
4. Add regression tests (compiled bundle + runtime execute) to prove map
   callbacks no longer crash.
5. Back out any prior stopgap experiments, run the full suite (`deno task test`,
   js-runtime integration), and cut a release note summarising the behaviour
   change.

Once those pieces are in place we can remove the temporary restrictions around
`map` callbacks and trust the new transformer in the runtime without the legacy
fallbacks.
