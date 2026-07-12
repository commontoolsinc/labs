import { assert, assertEquals } from "@std/assert";
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

// Module-scope function hardening freezes every top-level callable and, for
// callables a `WriteAuthorizedBy` / `TrustedActionWrite` type references,
// stamps a verified-binding identity onto them. The existing
// `module-scope-function-hardening.test.ts` covers the named function
// declaration paths. These tests target the still-uncovered shapes: an
// anonymous default-exported function declaration (hardened in place on the
// export assignment), async modifier retention on that rewrite, and a
// trusted binding whose initializer is a direct arrow function bound to a
// non-exported name (statement-form annotation plus a separate hardening call).

async function transform(source: string): Promise<string> {
  return await transformSource(source, { types: COMMONFABRIC_TYPES });
}

Deno.test(
  "anonymous default-exported function declaration is hardened in place on the export assignment",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern } from "commonfabric";\n` +
        `export default function () { return 1; }\n`,
    );

    // The nameless default export cannot be referenced by name, so the
    // function expression is wrapped where it stands —
    // `export default __cfHardenFn(function () { ... });` — with no synthetic
    // binding minted. (An earlier rewrite minted a `const` via
    // `createUniqueName` but exported an identifier re-created from its bare
    // `.text`, so the declared and exported names diverged and the module
    // threw a ReferenceError at load.)
    const root = parseModule(output);
    const exported = defaultExportExpression(root);
    assert(exported && ts.isCallExpression(exported));
    assert(
      ts.isIdentifier(exported.expression) &&
        exported.expression.text === "__cfHardenFn",
    );
    assertEquals(exported.arguments.length, 1);
    const wrapped = exported.arguments[0]!;
    assert(ts.isFunctionExpression(wrapped));
    assert(
      !wrapped.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      "expected the wrapped function to be non-async",
    );
    assert(
      !output.includes("__cfDefaultFn"),
      "expected no synthetic default-fn binding in the output",
    );
  },
);

Deno.test(
  "anonymous default-exported async function keeps its async modifier through the in-place rewrite",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern } from "commonfabric";\n` +
        `export default async function () { return 1; }\n`,
    );

    // Only the `async` modifier survives on the generated function expression;
    // `export`/`default` are carried by the export assignment itself
    // (`retainRuntimeFunctionModifiers`).
    const root = parseModule(output);
    const exported = defaultExportExpression(root);
    assert(exported && ts.isCallExpression(exported));
    assert(
      ts.isIdentifier(exported.expression) &&
        exported.expression.text === "__cfHardenFn",
    );
    const wrapped = exported.arguments[0]!;
    assert(ts.isFunctionExpression(wrapped));
    assertEquals(wrapped.modifiers?.length, 1);
    assertEquals(wrapped.modifiers?.[0]?.kind, ts.SyntaxKind.AsyncKeyword);
    assert(
      !output.includes("__cfDefaultFn"),
      "expected no synthetic default-fn binding in the output",
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
