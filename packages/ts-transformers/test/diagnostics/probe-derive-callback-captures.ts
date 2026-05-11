/**
 * Audit probe: enumerate `derive(...)` calls in pipeline output whose
 * callback closes over outer-scope bindings that aren't passed in via the
 * derive's inputs.
 *
 * Background: the SES / module-hoist contract says builder callbacks
 * (`derive`, `handler`, `lift`, `pattern`, `patternTool`) should be
 * hoistable to module scope — i.e. self-contained, sandbox-safe units that
 * receive everything they need via explicit parameters. When a derive
 * callback captures an outer binding that ISN'T in its destructured params,
 * the binding flows through lexical closure rather than the inputs
 * argument. That works in-process today via JS closure semantics but
 * breaks the self-contained-callback contract — the captured value
 * isn't visible to schema/serialization/sandbox machinery.
 *
 * This probe runs the full transformer pipeline on each fixture input,
 * parses the output, walks every `__cfHelpers.derive(...)` call, and
 * reports any free identifier in the callback body that isn't covered
 * by the destructure / inner locals / module scope / known helpers.
 *
 * Operates on the *output* AST so symbol resolution doesn't get confused
 * by original-node provenance from the source-side transformer rewrites.
 *
 * Usage (from packages/ts-transformers):
 *   deno run -A test/diagnostics/probe-derive-callback-captures.ts
 *   deno run -A test/diagnostics/probe-derive-callback-captures.ts <substr>
 *
 * Output: TSV on stdout (one row per finding). Summary on stderr.
 *
 * Diagnostic; not a test. Safe to delete once the bug class is closed.
 */
import ts from "typescript";
import { join } from "@std/path";
import { walk } from "@std/fs";

import { transformSource } from "../utils.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

const FIXTURE_ROOT = join(import.meta.dirname!, "..", "fixtures");

// Names we should never flag as captures: built-ins, runtime helpers,
// well-known Common Fabric symbols.
const KNOWN_NON_REACTIVE = new Set([
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
  "VNode",
  "NAME",
  "UI",
  "FS",
  "SELF",
  "JSONSchema",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "encodeURIComponent",
  "decodeURI",
  "decodeURIComponent",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "const",
]);

interface Hit {
  fixture: string;
  callerLine: number;
  capturedName: string;
  bodyExcerpt: string;
}

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
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "__cfHelpers" &&
    ts.isIdentifier(callee.name) &&
    callee.name.text === "derive"
  ) return true;
  if (ts.isIdentifier(callee) && callee.text === "derive") return true;
  return false;
}

function getDeriveCallback(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const arg = call.arguments[i];
    if (
      arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
    ) return arg;
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
 * - bound by the function's parameters
 * - declared locally inside the body (var/const/let/nested-function-params)
 * - module-scope (imports, top-level decls, runtime helpers)
 * - property names in property accesses
 * - declaration names
 */
function collectClosureCaptures(
  body: ts.ConciseBody,
  paramBindings: Set<string>,
  moduleScope: Set<string>,
): Set<string> {
  const captures = new Set<string>();
  const innerLocals = new Set<string>();

  // First pass: collect inner locals.
  const collectLocals = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, innerLocals);
    }
    if (ts.isFunctionLike(node) && node !== body && node !== body.parent) {
      for (const p of (node as ts.SignatureDeclarationBase).parameters ?? []) {
        collectBindingNames(p.name, innerLocals);
      }
    }
    ts.forEachChild(node, collectLocals);
  };
  collectLocals(body);

  // Second pass: find Identifier references that are reads.
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
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
        if (
          ts.isPropertyAccessExpression(parent) && parent.name === node
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        if (
          (ts.isPropertyAssignment(parent) ||
            ts.isShorthandPropertyAssignment(parent) ||
            ts.isMethodSignature(parent)) &&
          (parent as { name?: ts.Node }).name === node
        ) {
          if (!ts.isShorthandPropertyAssignment(parent)) {
            ts.forEachChild(node, visit);
            return;
          }
        }
        if (
          (ts.isJsxOpeningElement(parent) ||
            ts.isJsxClosingElement(parent) ||
            ts.isJsxSelfClosingElement(parent)) &&
          parent.tagName === node
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        if (ts.isJsxAttribute(parent) && parent.name === node) {
          ts.forEachChild(node, visit);
          return;
        }
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

async function loadFixtureFiles(
  match?: string,
): Promise<Array<{ rel: string; text: string }>> {
  const out: Array<{ rel: string; text: string }> = [];
  for await (const entry of walk(FIXTURE_ROOT, { exts: [".tsx", ".ts"] })) {
    if (!entry.isFile) continue;
    if (
      !entry.name.endsWith(".input.tsx") && !entry.name.endsWith(".input.ts")
    ) continue;
    const rel = entry.path.slice(FIXTURE_ROOT.length + 1);
    if (match && !rel.includes(match)) continue;
    out.push({ rel, text: await Deno.readTextFile(entry.path) });
  }
  return out;
}

async function main() {
  const matchArg = Deno.args[0];
  const files = await loadFixtureFiles(matchArg);
  console.error(`Loaded ${files.length} fixture(s).`);

  const hits: Hit[] = [];
  let processed = 0;
  let transformFailures = 0;

  for (const file of files) {
    processed++;
    let output: string;
    try {
      output = await transformSource(file.text, { types: COMMONFABRIC_TYPES });
    } catch (err) {
      transformFailures++;
      console.error(
        `[skip] ${file.rel}: transform failed: ${
          (err as Error).message?.slice(0, 80)
        }`,
      );
      continue;
    }

    let outSourceFile: ts.SourceFile;
    try {
      outSourceFile = ts.createSourceFile(
        file.rel + ".out",
        output,
        ts.ScriptTarget.ES2020,
        true,
        ts.ScriptKind.TSX,
      );
    } catch (err) {
      console.error(
        `[skip-parse] ${file.rel}: ${(err as Error).message?.slice(0, 80)}`,
      );
      continue;
    }

    const moduleScope = collectModuleScopeNames(outSourceFile);

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
            const line = outSourceFile.getLineAndCharacterOfPosition(
              node.getStart(outSourceFile),
            ).line + 1;
            const bodyText = callback.body.getText(outSourceFile)
              .replace(/\s+/g, " ")
              .slice(0, 160);
            for (const name of captures) {
              hits.push({
                fixture: file.rel,
                callerLine: line,
                capturedName: name,
                bodyExcerpt: bodyText,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(outSourceFile);
  }

  console.log(["fixture", "line", "name", "body"].join("\t"));
  for (const hit of hits) {
    console.log(
      [hit.fixture, hit.callerLine, hit.capturedName, hit.bodyExcerpt].join(
        "\t",
      ),
    );
  }

  console.error("");
  console.error("=== summary ===");
  console.error(`fixtures processed:                    ${processed}`);
  console.error(`transform failures (skipped):          ${transformFailures}`);
  console.error(`derive callbacks with closure captures: ${hits.length}`);
  const byFixture = new Map<string, number>();
  for (const hit of hits) {
    byFixture.set(hit.fixture, (byFixture.get(hit.fixture) ?? 0) + 1);
  }
  console.error(`distinct fixtures affected:            ${byFixture.size}`);
  console.error("");
  console.error("captures by frequency:");
  const captureFreq = new Map<string, number>();
  for (const hit of hits) {
    captureFreq.set(
      hit.capturedName,
      (captureFreq.get(hit.capturedName) ?? 0) + 1,
    );
  }
  const sorted = Array.from(captureFreq.entries()).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted.slice(0, 30)) {
    console.error(`  ${count.toString().padStart(4)}  ${name}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
}
