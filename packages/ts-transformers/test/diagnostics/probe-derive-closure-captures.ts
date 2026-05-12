/**
 * Audit probe: find derive() calls whose callback closes over a reactive
 * binding that isn't declared in the derive's inputs/destructure.
 *
 * Walks every `.expected.jsx` / `.expected.js` fixture, parses it, finds every
 * `__cfHelpers.derive(...)` and `derive(...)` call, and reports any
 * identifiers its callback body references via closure capture (not
 * destructured from its parameters, not module-level, not a known runtime
 * helper).
 *
 * Usage (from packages/ts-transformers):
 *   deno run -A test/probe-derive-closure-captures.ts          # all fixtures
 *   deno run -A test/probe-derive-closure-captures.ts <substr> # subset
 *
 * Output: TSV on stdout. Summary on stderr.
 *
 * One-shot diagnostic. Safe to delete once the audit is complete.
 */
import ts from "typescript";
import { join } from "@std/path";
import { walk } from "@std/fs";

const FIXTURE_ROOT = join(import.meta.dirname!, "..", "fixtures");

// Names we should not flag as closure captures even if they're not in the
// derive's parameters: they refer to module-scope or runtime infrastructure.
const KNOWN_NON_REACTIVE = new Set([
  // TypeScript / runtime built-ins
  "__cfHelpers",
  "__cfHardenFn",
  "__cf_pattern_input",
  "h",
  "undefined",
  "null",
  "true",
  "false",
  "NaN",
  "Infinity",
  "console",
  "Math",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "JSON",
  "Date",
  "Symbol",
  "Map",
  "Set",
  "Promise",
  // Common Fabric runtime / well-known
  "VNode",
  "NAME",
  "UI",
  "FS",
  "SELF",
  "JSONSchema",
  // Global functions
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "encodeURIComponent",
  "decodeURI",
  "decodeURIComponent",
  // Type-only references that appear in TypeScript ASTs as identifiers
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "const",
]);

function collectBindingNames(
  binding: ts.BindingName,
  out: Set<string>,
): void {
  if (ts.isIdentifier(binding)) {
    out.add(binding.text);
    return;
  }
  if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
    for (const el of binding.elements) {
      if (ts.isOmittedExpression(el)) continue;
      // For object binding, the `name` is the local binding name; the
      // `propertyName` is the source key.
      collectBindingNames(el.name, out);
    }
  }
}

function collectModuleScopeNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>(KNOWN_NON_REACTIVE);
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const ic = stmt.importClause;
      if (ic.name) names.add(ic.name.text);
      if (ic.namedBindings) {
        if (ts.isNamedImports(ic.namedBindings)) {
          for (const spec of ic.namedBindings.elements) {
            names.add(spec.name.text);
          }
        } else {
          names.add(ic.namedBindings.name.text);
        }
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        collectBindingNames(decl.name, names);
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isEnumDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

function isDeriveCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  // __cfHelpers.derive
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "__cfHelpers" &&
    ts.isIdentifier(callee.name) &&
    callee.name.text === "derive"
  ) {
    return true;
  }
  // bare derive(...)
  if (ts.isIdentifier(callee) && callee.text === "derive") {
    return true;
  }
  return false;
}

/**
 * A `derive(...)` call's callback is the LAST argument that is a function
 * expression. (Signatures vary: 1 arg = (inputs, callback) shorthand; with
 * schema injection it becomes (inputSchema, resultSchema, inputs, callback).)
 */
function getDeriveCallback(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const arg = call.arguments[i];
    if (
      arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
    ) {
      return arg;
    }
  }
  return undefined;
}

function collectCallbackParamBindings(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): Set<string> {
  const out = new Set<string>();
  for (const param of callback.parameters) {
    collectBindingNames(param.name, out);
  }
  return out;
}

/**
 * Walk a function body and collect identifier references that are not:
 * - bound by the function's parameters (or nested functions / locals)
 * - module-scope (imports / top-level decls)
 * - property names in property accesses
 * - declaration names
 */
function collectClosureCaptures(
  body: ts.ConciseBody,
  paramBindings: Set<string>,
  moduleScope: Set<string>,
): Set<string> {
  const captures = new Set<string>();
  // Track all binding names introduced inside the body so we don't
  // mis-attribute locals as captures.
  const innerLocals = new Set<string>();

  const collectFromVarDecl = (node: ts.VariableDeclaration): void => {
    collectBindingNames(node.name, innerLocals);
  };
  const collectFromParam = (node: ts.ParameterDeclaration): void => {
    collectBindingNames(node.name, innerLocals);
  };

  // First pass: collect inner locals (var/const/let, nested function params).
  const collectLocals = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) collectFromVarDecl(node);
    if (
      ts.isFunctionLike(node) && node !== body && node !== body.parent
    ) {
      for (const p of (node as ts.SignatureDeclarationBase).parameters ?? []) {
        collectFromParam(p);
      }
    }
    ts.forEachChild(node, collectLocals);
  };
  collectLocals(body);

  // Second pass: find Identifier references that are reads (not property
  // names, not declaration names) and not satisfied by paramBindings /
  // moduleScope / innerLocals.
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      // Skip declaration positions.
      if (parent) {
        if (
          (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isFunctionExpression(parent) ||
            ts.isArrowFunction(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isBindingElement(parent)) &&
          (parent as { name?: ts.Node }).name === node
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        // Skip the RHS of a property-access expression (i.e., `foo.BAR` —
        // BAR is a property name, not a reference).
        if (
          ts.isPropertyAccessExpression(parent) && parent.name === node
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        // Skip property names in property assignments.
        if (
          (ts.isPropertyAssignment(parent) ||
            ts.isShorthandPropertyAssignment(parent) ||
            ts.isMethodSignature(parent)) &&
          (parent as { name?: ts.Node }).name === node
        ) {
          // For shorthand `{ foo }`, the identifier IS a read, so do not skip.
          if (!ts.isShorthandPropertyAssignment(parent)) {
            ts.forEachChild(node, visit);
            return;
          }
        }
        // Skip JSX tag names (`<Foo>`, `</Foo>`, `<Foo />`).
        if (
          (ts.isJsxOpeningElement(parent) ||
            ts.isJsxClosingElement(parent) ||
            ts.isJsxSelfClosingElement(parent)) &&
          parent.tagName === node
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        // Skip JSX attribute names (`<Foo bar={...} />`).
        if (ts.isJsxAttribute(parent) && parent.name === node) {
          ts.forEachChild(node, visit);
          return;
        }
        // Skip type-position identifiers (TypeReference, ExpressionWithTypeArguments,
        // QualifiedName in type position, etc.). For as/satisfies/type-assertion
        // forms the inner Identifier sits in the `expression` slot (the value
        // side); the `type` slot is structurally a TypeNode so an Identifier
        // can never appear there.
        if (
          ts.isTypeReferenceNode(parent) ||
          ts.isTypeQueryNode(parent) ||
          ts.isExpressionWithTypeArguments(parent) ||
          ts.isQualifiedName(parent) ||
          ts.isTypeAliasDeclaration(parent) ||
          ts.isInterfaceDeclaration(parent) ||
          ts.isHeritageClause(parent)
        ) {
          ts.forEachChild(node, visit);
          return;
        }
      }
      const name = node.text;
      if (
        !paramBindings.has(name) &&
        !moduleScope.has(name) &&
        !innerLocals.has(name)
      ) {
        captures.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);

  return captures;
}

interface Hit {
  fixture: string;
  callLine: number;
  callee: string;
  paramBindings: string[];
  captures: string[];
  callbackBodyText: string;
}

async function loadFixtureFiles(
  match?: string,
): Promise<Array<{ path: string; rel: string; text: string }>> {
  const out: Array<{ path: string; rel: string; text: string }> = [];
  for await (const entry of walk(FIXTURE_ROOT, { exts: [".jsx", ".js"] })) {
    if (!entry.isFile) continue;
    if (
      !entry.name.endsWith(".expected.jsx") &&
      !entry.name.endsWith(".expected.js")
    ) {
      continue;
    }
    const rel = entry.path.slice(FIXTURE_ROOT.length + 1);
    if (match && !rel.includes(match)) continue;
    out.push({
      path: entry.path,
      rel,
      text: await Deno.readTextFile(entry.path),
    });
  }
  return out;
}

async function main() {
  const matchArg = Deno.args[0];
  const files = await loadFixtureFiles(matchArg);
  if (files.length === 0) {
    console.error(`No expected-fixtures matched ${matchArg ?? "(all)"}.`);
    Deno.exit(2);
  }
  console.error(`Loaded ${files.length} expected-fixture(s).`);

  const hits: Hit[] = [];

  for (const file of files) {
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(
        file.path,
        file.text,
        ts.ScriptTarget.ES2020,
        true,
        ts.ScriptKind.TSX,
      );
    } catch (err) {
      console.error(`parse failed for ${file.rel}: ${err}`);
      continue;
    }

    const moduleScope = collectModuleScopeNames(sourceFile);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isDeriveCall(node)) {
        const callback = getDeriveCallback(node);
        if (callback) {
          const params = collectCallbackParamBindings(callback);
          const captures = collectClosureCaptures(
            callback.body,
            params,
            moduleScope,
          );
          if (captures.size > 0) {
            const line = sourceFile.getLineAndCharacterOfPosition(
              node.getStart(sourceFile),
            ).line + 1;
            const bodyText = callback.body.getText(sourceFile)
              .replace(/\s+/g, " ")
              .slice(0, 200);
            hits.push({
              fixture: file.rel,
              callLine: line,
              callee: ts.isPropertyAccessExpression(node.expression)
                ? `${(node.expression.expression as ts.Identifier).text}.${
                  (node.expression.name as ts.Identifier).text
                }`
                : (node.expression as ts.Identifier).text,
              paramBindings: Array.from(params).sort(),
              captures: Array.from(captures).sort(),
              callbackBodyText: bodyText,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // TSV header.
  console.log(
    ["fixture", "line", "callee", "params", "captures", "body"].join("\t"),
  );
  for (const hit of hits) {
    console.log(
      [
        hit.fixture,
        hit.callLine,
        hit.callee,
        hit.paramBindings.join(","),
        hit.captures.join(","),
        hit.callbackBodyText,
      ].join("\t"),
    );
  }

  console.error("");
  console.error("=== summary ===");
  console.error(`derive() callbacks with closure captures: ${hits.length}`);
  const byFixture = new Map<string, number>();
  for (const hit of hits) {
    byFixture.set(hit.fixture, (byFixture.get(hit.fixture) ?? 0) + 1);
  }
  console.error(`distinct fixtures affected:               ${byFixture.size}`);
  console.error("");
  console.error("captures by frequency:");
  const captureFreq = new Map<string, number>();
  for (const hit of hits) {
    for (const cap of hit.captures) {
      captureFreq.set(cap, (captureFreq.get(cap) ?? 0) + 1);
    }
  }
  const sorted = Array.from(captureFreq.entries()).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted.slice(0, 25)) {
    console.error(`  ${count.toString().padStart(4)}  ${name}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
}
