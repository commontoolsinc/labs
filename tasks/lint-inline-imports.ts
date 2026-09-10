/// <reference lib="deno.unstable" />

/**
 * Lint rules that keep a module's dependencies readable off the top of its
 * file.
 *
 * A file's `import` declarations are the list of what it depends on. Two
 * constructs write a dependency somewhere else instead:
 *
 *   - `import("./mod.ts").Thing` in a type position. This form exists so that
 *     a `.d.ts` can name a type without a declaration of its own; in ordinary
 *     source it only hides an edge and repeats the module specifier at every
 *     use. TypeScript erases `import type` entirely, so the top-of-file form
 *     is equivalent everywhere except in an ambient declaration file that has
 *     no imports, where adding one would make the file a module and its
 *     `declare` statements stop being global. `no-inline-type-import` reports
 *     every inline type; that one shape takes a directive.
 *   - `import("./mod.ts")` as an expression. This one has real uses: loading a
 *     module the environment may not have, deferring a load that costs
 *     something at import time, or fetching a module instance at a moment the
 *     code chooses. `no-inline-module-import` reports the form that names its
 *     module with a plain string, which is the form that has a top-of-file
 *     equivalent, and leaves a computed specifier alone because that one has
 *     none.
 *
 * A deliberate deferred load stays, with the reason written above it. A Deno
 * directive applies to the line right after it, so the directive itself is the
 * last line of the comment block:
 *
 *     // @db/sqlite opens its native library as it loads, and this path runs
 *     // without it.
 *     // deno-lint-ignore cf-imports/no-inline-module-import
 *     const { open } = await import("./sqlite-store.ts");
 *
 * A file whose whole subject is module loading takes one directive at the top
 * instead of one per site:
 *
 *     // deno-lint-ignore-file cf-imports/no-inline-module-import -- each test
 *     // installs its browser globals before the view module loads.
 *
 * A file gets one of those and no more: Deno reads the first and ignores any
 * that follow, so a second directive suppresses nothing and reads as though it
 * did. A file that already carries one names every rule it needs on that one
 * line.
 *
 *     // deno-lint-ignore-file no-explicit-any cf-imports/no-inline-module-import
 *
 * See docs/development/imports.md.
 */

const TYPE_MESSAGE =
  'A type written as `import("...").Name` hides a dependency that belongs ' +
  "in the file's import list. Declare it at the top with `import type` — " +
  "TypeScript erases the declaration, so nothing about the build or the " +
  "load order changes. For a whole module, `import type * as name from " +
  '"..."` and then `typeof name`. See docs/development/imports.md.';

const MODULE_MESSAGE =
  'A dynamic `import("...")` naming its module with a plain string has a ' +
  "top-of-file equivalent, so write it there. Where the load is deferred on " +
  "purpose — an optional dependency, a module that costs something at " +
  "import time, or one instance per call — keep it and say which, with " +
  "`// deno-lint-ignore cf-imports/no-inline-module-import -- <reason>`. " +
  "See docs/development/imports.md.";

/** The shape these rules read off a node, on top of the type tag. */
interface ImportNode {
  readonly type: string;
  readonly source?: { readonly type: string; readonly value?: unknown };
}

export default {
  name: "cf-imports",
  rules: {
    "no-inline-type-import": {
      create(context) {
        return {
          TSImportType(node) {
            context.report({ node, message: TYPE_MESSAGE });
          },
        };
      },
    },

    "no-inline-module-import": {
      create(context) {
        return {
          ImportExpression(node) {
            // A computed specifier — a template literal, a variable, a URL
            // built at run time — names a module no import declaration can
            // name, so it is left alone. The value is checked as well as the
            // node type, because a number, a regular expression and `null` are
            // all `Literal` too, and none of them is a module specifier an
            // import declaration could carry.
            const { source } = node as unknown as ImportNode;
            if (source?.type !== "Literal") return;
            if (typeof source.value !== "string") return;
            context.report({ node, message: MODULE_MESSAGE });
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
