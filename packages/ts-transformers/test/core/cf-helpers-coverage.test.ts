/**
 * Unit coverage for `src/core/cf-helpers.ts`.
 *
 * These tests exercise the CFHelpers class's import-scanning constructor and its
 * expression/qualified-name factory methods, plus the module-level import-shape
 * recognizers `getCFHelpersIdentifier` / `getCFDataHelperIdentifier` (reached
 * indirectly through the constructor and `sourceHasHelpers` /
 * `sourceHasDataHelper`).
 *
 * The recognizers accept only a named import of `__cfHelpers` (or `__cf_data`
 * aliased to `__cfDataHelper`) from the "commonfabric" module specifier. Each
 * test pins one gate of that shape by feeding a source whose import differs in
 * exactly one respect and asserting whether the helper is detected.
 */
import ts from "typescript";
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  CF_DATA_HELPER_IDENTIFIER,
  CF_HELPERS_IDENTIFIER,
  CFHelpers,
  injectCfHelpers,
  sourceDisablesCfTransform,
  transformCfDirective,
} from "../../src/core/cf-helpers.ts";

function sourceFileFor(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "/test.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
}

function helpersFor(source: string): CFHelpers {
  return new CFHelpers({
    sourceFile: sourceFileFor(source),
    factory: ts.factory,
  });
}

function printExpr(node: ts.Node, sourceFile: ts.SourceFile): string {
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(
    ts.EmitHint.Unspecified,
    node,
    sourceFile,
  );
}

// ---------------------------------------------------------------------------
// Constructor scanning: getCFHelpersIdentifier / getCFDataHelperIdentifier
// ---------------------------------------------------------------------------

Deno.test("CFHelpers detects the __cfHelpers named import from commonfabric", () => {
  const helpers = helpersFor(
    `import { __cfHelpers } from "commonfabric";`,
  );
  assert(helpers.sourceHasHelpers());
  assertFalse(helpers.sourceHasDataHelper());
});

Deno.test("CFHelpers detects a renamed __cfHelpers import via its property name", () => {
  // `element.propertyName` is `__cfHelpers`; the local binding is `h`. The
  // scanner keys on the imported (property) name, so it still resolves the
  // helper and stores the local alias identifier.
  const helpers = helpersFor(
    `import { __cfHelpers as h } from "commonfabric";`,
  );
  assert(helpers.sourceHasHelpers());

  const sf = sourceFileFor(`import { __cfHelpers as h } from "commonfabric";`);
  const expr = new CFHelpers({ sourceFile: sf, factory: ts.factory })
    .getHelperExpr("lift");
  // The stored identifier is the local alias `h`, not the imported name.
  assertEquals(printExpr(expr, sf), "h.lift");
});

Deno.test("CFHelpers ignores __cfHelpers imported from a non-commonfabric module", () => {
  const helpers = helpersFor(
    `import { __cfHelpers } from "other-module";`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores an import whose specifier is not a string literal", () => {
  // A bare `import mod = require(...)` has no StringLiteral module specifier, so
  // the `ts.isStringLiteral(moduleSpecifier)` guard rejects it.
  const helpers = helpersFor(
    `import __cfHelpers = require("commonfabric");`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores a default (non-named) import from commonfabric", () => {
  // `import __cfHelpers from "commonfabric"` has an import clause but no
  // NamedImports binding, so the `ts.isNamedImports(namedBindings)` guard fails.
  const helpers = helpersFor(
    `import __cfHelpers from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores a namespace import from commonfabric", () => {
  // `import * as __cfHelpers` produces a NamespaceImport binding, not
  // NamedImports.
  const helpers = helpersFor(
    `import * as __cfHelpers from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores commonfabric named imports that are not __cfHelpers", () => {
  const helpers = helpersFor(
    `import { pattern, Cell } from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores a bare import declaration with no import clause", () => {
  // `import "commonfabric"` has `importClause === undefined`.
  const helpers = helpersFor(`import "commonfabric";`);
  assertFalse(helpers.sourceHasHelpers());
  assertFalse(helpers.sourceHasDataHelper());
});

Deno.test("CFHelpers detects the __cf_data data helper import aliased to __cfDataHelper", () => {
  // The data helper is only recognized as `__cf_data as __cfDataHelper`.
  const helpers = helpersFor(
    `import { __cf_data as __cfDataHelper } from "commonfabric";`,
  );
  assert(helpers.sourceHasDataHelper());
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers rejects a data helper import whose local name is not __cfDataHelper", () => {
  // `element.name.text` must equal `__cfDataHelper`; here it is `other`.
  const helpers = helpersFor(
    `import { __cf_data as other } from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasDataHelper());
});

Deno.test("CFHelpers rejects a data helper import whose imported name is not __cf_data", () => {
  // Local name matches `__cfDataHelper`, but the imported (property) name is
  // `wrong`, not `__cf_data`, so the second gate rejects it.
  const helpers = helpersFor(
    `import { wrong as __cfDataHelper } from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasDataHelper());
});

Deno.test("CFHelpers ignores a data-helper-shaped import from a foreign module", () => {
  const helpers = helpersFor(
    `import { __cf_data as __cfDataHelper } from "other-module";`,
  );
  assertFalse(helpers.sourceHasDataHelper());
});

Deno.test("CFHelpers ignores a data helper default import from commonfabric", () => {
  // Import clause present but no NamedImports binding.
  const helpers = helpersFor(
    `import __cfDataHelper from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasDataHelper());
});

// ---------------------------------------------------------------------------
// getHelperExpr / getHelperQualified / getDataHelperExpr
// ---------------------------------------------------------------------------

Deno.test("getHelperExpr throws when the source has no helpers import", () => {
  const helpers = helpersFor(`const x = 1;`);
  assertThrows(
    () => helpers.getHelperExpr("lift"),
    Error,
    "Source file does not contain helpers.",
  );
});

Deno.test("getHelperExpr without an original node builds a plain property access", () => {
  const source = `import { __cfHelpers } from "commonfabric";`;
  const sf = sourceFileFor(source);
  const helpers = new CFHelpers({ sourceFile: sf, factory: ts.factory });
  const expr = helpers.getHelperExpr("lift");
  assert(ts.isPropertyAccessExpression(expr));
  assertEquals(printExpr(expr, sf), "__cfHelpers.lift");
});

Deno.test("getHelperExpr with an original node preserves source map ranges and identity", () => {
  const source =
    `import { __cfHelpers } from "commonfabric";\nconst marker = 1;`;
  const sf = sourceFileFor(source);
  const helpers = new CFHelpers({ sourceFile: sf, factory: ts.factory });

  // Any node from the source works as the original-node anchor.
  let original: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (!original && ts.isNumericLiteral(node)) original = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert(original);

  const expr = helpers.getHelperExpr("lift", original);
  assert(ts.isPropertyAccessExpression(expr));
  // The whole property-access is anchored to the original node's source map
  // range (its position), distinguishing this branch from the no-original one.
  assertEquals(ts.getSourceMapRange(expr).pos, original.pos);
  assertEquals(printExpr(expr, sf), "__cfHelpers.lift");
});

Deno.test("getHelperQualified throws when the source has no helpers import", () => {
  const helpers = helpersFor(`const x = 1;`);
  assertThrows(
    () => helpers.getHelperQualified("JSONSchema"),
    Error,
    "Source file does not contain helpers.",
  );
});

Deno.test("getHelperQualified builds a qualified name against the helper identifier", () => {
  const source = `import { __cfHelpers } from "commonfabric";`;
  const sf = sourceFileFor(source);
  const helpers = new CFHelpers({ sourceFile: sf, factory: ts.factory });
  const qualified = helpers.getHelperQualified("JSONSchema");
  assert(ts.isQualifiedName(qualified));
  assertEquals(qualified.right.text, "JSONSchema");
  assertEquals((qualified.left as ts.Identifier).text, CF_HELPERS_IDENTIFIER);
});

Deno.test("getDataHelperExpr throws when the source has no data helper import", () => {
  const helpers = helpersFor(`const x = 1;`);
  assertThrows(
    () => helpers.getDataHelperExpr(),
    Error,
    "Source file does not contain __cfDataHelper.",
  );
});

Deno.test("getDataHelperExpr without an original node returns a bare data-helper identifier", () => {
  const source = `import { __cf_data as __cfDataHelper } from "commonfabric";`;
  const sf = sourceFileFor(source);
  const helpers = new CFHelpers({ sourceFile: sf, factory: ts.factory });
  const ident = helpers.getDataHelperExpr();
  assert(ts.isIdentifier(ident));
  assertEquals(ident.text, CF_DATA_HELPER_IDENTIFIER);
});

Deno.test("getDataHelperExpr with an original node preserves its source map range", () => {
  const source =
    `import { __cf_data as __cfDataHelper } from "commonfabric";\nconst marker = 2;`;
  const sf = sourceFileFor(source);
  const helpers = new CFHelpers({ sourceFile: sf, factory: ts.factory });

  let original: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (!original && ts.isNumericLiteral(node)) original = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert(original);

  const ident = helpers.getDataHelperExpr(original);
  assert(ts.isIdentifier(ident));
  assertEquals(ident.text, CF_DATA_HELPER_IDENTIFIER);
  assertEquals(ts.getSourceMapRange(ident).pos, original.pos);
});

// ---------------------------------------------------------------------------
// transformCfDirective / injectCfHelpers (string passes)
// ---------------------------------------------------------------------------

Deno.test("transformCfDirective returns an all-blank source unchanged", () => {
  // With no content line, `findFirstContentLineIndex` returns null and the
  // source is returned verbatim before any injection.
  const source = "\n   \n\t\n";
  assertEquals(transformCfDirective(source), source);
});

Deno.test("transformCfDirective injects the helpers import for an ordinary source", () => {
  const source = `const answer = 42;`;
  const out = transformCfDirective(source);
  // Prepends the `__cfHelpers` import prelude and appends the used-helper
  // shim so binding survives tree-shaking.
  assert(out.startsWith(`import { ${CF_HELPERS_IDENTIFIER} } from`));
  assert(out.includes(source));
  assert(out.includes(`${CF_HELPERS_IDENTIFIER}.h.apply`));
});

Deno.test("transformCfDirective blanks a leading cf-disable-transform directive", () => {
  const source = `/// <cf-disable-transform />\nconst answer = 42;`;
  assert(sourceDisablesCfTransform(source));
  const out = transformCfDirective(source);
  const lines = out.split("\n");
  // The directive line is replaced by an empty line; no helper import is added.
  assertEquals(lines[0], "");
  assertEquals(lines[1], "const answer = 42;");
  assertFalse(out.includes(CF_HELPERS_IDENTIFIER));
});

Deno.test("injectCfHelpers uses TypeScript helper-shim syntax by default", () => {
  const out = injectCfHelpers(`const x = 1;`);
  // The TS variant carries the `: any[]` rest annotation.
  assert(out.includes("function h(...args: any[])"));
});

Deno.test("injectCfHelpers uses JS-only helper-shim syntax for JavaScript file names", () => {
  const out = injectCfHelpers(`const x = 1;`, "authored.jsx");
  // The JS variant drops the type annotation to stay parseable in .jsx.
  assert(out.includes("function h(...args)"));
  assertFalse(out.includes("function h(...args: any[])"));
});

Deno.test("injectCfHelpers throws when the source already uses the reserved helper symbol", () => {
  assertThrows(
    () => injectCfHelpers(`const ${CF_HELPERS_IDENTIFIER} = {};`),
    Error,
    `reserved helper symbol '${CF_HELPERS_IDENTIFIER}'`,
  );
});
