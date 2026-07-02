import { assert } from "@std/assert";
import ts from "typescript";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, collect, parseModule } from "./transformed-ast.ts";

/** The single default-export assignment's expression, if any. */
function defaultExportExpression(
  root: ts.SourceFile,
): ts.Expression | undefined {
  const assignment = collect(root, ts.isExportAssignment).find((node) =>
    !node.isExportEquals
  );
  return assignment?.expression;
}

/** The variable declaration whose name starts with `prefix`, if any. */
function variableNamed(
  root: ts.SourceFile,
  prefix: string,
): ts.VariableDeclaration | undefined {
  return collect(root, ts.isVariableDeclaration).find((decl) =>
    ts.isIdentifier(decl.name) && decl.name.text.startsWith(prefix)
  );
}

/** The `__cfHardenFn(...)` call whose first argument is a function expression. */
function hardenedFunctionExpression(
  root: ts.SourceFile,
): ts.FunctionExpression | undefined {
  for (const call of callsNamed(root, "__cfHardenFn")) {
    const arg = call.arguments[0];
    if (arg && ts.isFunctionExpression(arg)) return arg;
  }
  return undefined;
}

// Module-scope function hardening freezes every top-level callable and, for
// callables a `WriteAuthorizedBy` / `TrustedActionWrite` type references,
// stamps a verified-binding identity onto them. The existing
// `module-scope-function-hardening.test.ts` covers the named function
// declaration paths. These tests target the still-uncovered shapes: an
// anonymous default-exported function declaration (rewritten to a hoisted const
// plus a default export), async modifier retention on that rewrite, and a
// trusted binding whose initializer is a direct arrow function bound to a
// non-exported name (statement-form annotation plus a separate hardening call).

async function transform(source: string): Promise<string> {
  return await transformSource(source, { types: COMMONFABRIC_TYPES });
}

Deno.test(
  "anonymous default-exported function declaration is rewritten to a hardened const and a default export",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern } from "commonfabric";\n` +
        `export default function () { return 1; }\n`,
    );

    // The nameless default export cannot be referenced by name, so it is
    // lowered into a hoisted `const` bound to a hardened function expression and
    // re-exported by that generated name.
    const root = parseModule(output);
    const decl = variableNamed(root, "__cfDefaultFn");
    assert(decl, "expected a `const __cfDefaultFn` declaration");
    const exported = defaultExportExpression(root);
    assert(exported && ts.isIdentifier(exported));
    assert(exported.text.startsWith("__cfDefaultFn"));
    const wrapped = hardenedFunctionExpression(root);
    assert(wrapped, "expected __cfHardenFn to wrap a function expression");
    assert(
      !wrapped.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      "expected the wrapped function to be non-async",
    );
  },
);

Deno.test(
  "anonymous default-exported async function keeps its async modifier through the rewrite",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern } from "commonfabric";\n` +
        `export default async function () { return 1; }\n`,
    );

    // Only the `async` modifier survives on the generated function expression;
    // the export/default modifiers are dropped because the const carries the
    // export.
    const root = parseModule(output);
    const decl = variableNamed(root, "__cfDefaultFn");
    assert(decl, "expected a `const __cfDefaultFn` declaration");
    const exported = defaultExportExpression(root);
    assert(exported && ts.isIdentifier(exported));
    assert(exported.text.startsWith("__cfDefaultFn"));
    const wrapped = hardenedFunctionExpression(root);
    assert(wrapped, "expected __cfHardenFn to wrap a function expression");
    assert(
      wrapped.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      "expected the wrapped function expression to keep its async modifier",
    );
  },
);

Deno.test(
  "trusted arrow bound to a non-exported name gets a statement-form annotation and a separate hardening call",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern, WriteAuthorizedBy } from "commonfabric";\n` +
        `const saveTitle = (): string => "x";\n` +
        `interface Input { title: string; }\n` +
        `interface Output { savedTitle: WriteAuthorizedBy<string, typeof saveTitle>; }\n` +
        `export default pattern<Input, Output>(({ title }) => ({ savedTitle: title }));\n`,
    );

    // The binding is trusted (a WriteAuthorizedBy references it) and its
    // initializer is a direct arrow function, but the declaration is not
    // exported. The identity annotation and the hardening wrap are therefore
    // emitted as separate statements after the declaration rather than inlined
    // into the initializer.
    const root = parseModule(output);
    const saveTitle = variableNamed(root, "saveTitle");
    assert(saveTitle?.initializer, "expected a `saveTitle` declaration");
    assert(
      ts.isArrowFunction(saveTitle.initializer),
      "expected the annotation to be statement-form, not inlined into the initializer",
    );

    const argIsSaveTitle = (call: ts.CallExpression): boolean => {
      const arg = call.arguments[0];
      return !!arg && ts.isIdentifier(arg) && arg.text === "saveTitle";
    };
    assert(
      callsNamed(root, "__cfBindVerifiedBinding").some((call) =>
        argIsSaveTitle(call) && ts.isObjectLiteralExpression(call.arguments[1]!)
      ),
      "expected a statement-form __cfBindVerifiedBinding(saveTitle, { ... }) call",
    );
    assert(
      callsNamed(root, "__cfHardenFn").some(argIsSaveTitle),
      "expected a separate __cfHardenFn(saveTitle) hardening call",
    );
  },
);
