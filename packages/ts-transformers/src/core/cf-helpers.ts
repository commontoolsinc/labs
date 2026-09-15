import ts from "typescript";
import { preserveSourceMapRange } from "../ast/utils.ts";
import { TransformationContext } from "./mod.ts";

export const CF_HELPERS_IDENTIFIER = "__cfHelpers";

const CF_HELPERS_SPECIFIER = "commonfabric";

// Runner pattern coverage line remapping treats this helper import as a
// one-line prelude. Changes to its line count need a matching update in
// patternCoverageOptionsForCompile.
const HELPERS_STMT =
  `import { ${CF_HELPERS_IDENTIFIER} } from "${CF_HELPERS_SPECIFIER}";`;

// Name of the forwarding JSX-factory shim appended after the source. It is
// also the top-level binding name whose presence in the authored module swaps
// the shim for the bare use statement below (see `injectCfHelpers`).
const JSX_FACTORY_SHIM_NAME = "h";

const HELPERS_USED_STMT = `// @ts-ignore: Internals
function ${JSX_FACTORY_SHIM_NAME}(...args: any[]) { return ${CF_HELPERS_IDENTIFIER}.h.apply(null, args); }
`;
// Syntax-neutral variant injected into authored `.js`/`.jsx` sources, where the
// `: any[]` annotation above would be a parse error ("Type annotations can only
// be used in TypeScript files"). Keep both statements line-for-line identical
// so injection shifts source lines the same way regardless of file kind.
const HELPERS_USED_STMT_JS = `// @ts-ignore: Internals
function ${JSX_FACTORY_SHIM_NAME}(...args) { return ${CF_HELPERS_IDENTIFIER}.h.apply(null, args); }
`;
// Appended instead of the shim when the authored module already binds
// `JSX_FACTORY_SHIM_NAME` at top level, where a second declaration would be a
// duplicate identifier (TS2300). A plain use of the helper import is all the
// shim contributes to binding once JSX itself dispatches through
// `__cfHelpers.h`. Syntax-neutral, so one form serves both file kinds, and
// the same line count as the shim variants.
const HELPERS_USED_STMT_BARE = `// @ts-ignore: Internals
void ${CF_HELPERS_IDENTIFIER};
`;

export class CFHelpers {
  #sourceFile: ts.SourceFile;
  #factory: ts.NodeFactory;
  #helperIdent?: ts.Identifier;

  constructor(params: Pick<TransformationContext, "sourceFile" | "factory">) {
    this.#sourceFile = params.sourceFile;
    this.#factory = params.factory;

    for (const stmt of this.#sourceFile.statements) {
      const helperSymbol = getCFHelpersIdentifier(stmt);
      if (helperSymbol) {
        this.#helperIdent = helperSymbol;
      }
    }
  }

  sourceHasHelpers(): boolean {
    return !!this.#helperIdent;
  }

  /**
   * Carries the source-map range of `originalNode` and the checker identity of
   * `identityNode` onto `node` without assigning a text range. The range and
   * identity nodes may differ or coincide.
   */
  preserveNodeSourceMap<T extends ts.Node>(
    node: T,
    originalNode: ts.Node,
    identityNode: ts.Node,
  ): T {
    return ts.setOriginalNode(
      preserveSourceMapRange(node, originalNode),
      identityNode,
    ) as T;
  }

  getHelperExpr(
    name: string,
    originalNode?: ts.Node,
  ): ts.PropertyAccessExpression {
    if (!this.sourceHasHelpers()) {
      throw new Error("Source file does not contain helpers.");
    }

    if (!originalNode) {
      return this.#factory.createPropertyAccessExpression(
        this.#helperIdent!,
        name,
      );
    }

    const helperIdent = this.preserveNodeSourceMap(
      this.#factory.createIdentifier(this.#helperIdent!.text),
      originalNode,
      this.#helperIdent!,
    );
    const helperName = preserveSourceMapRange(
      this.#factory.createIdentifier(name),
      originalNode,
    );
    return preserveSourceMapRange(
      this.#factory.createPropertyAccessExpression(
        helperIdent,
        helperName,
      ),
      originalNode,
    );
  }

  createHelperCall(
    name: string,
    originalNode: ts.Node,
    typeArguments: readonly ts.TypeNode[] | undefined,
    argumentsArray: readonly ts.Expression[],
  ): ts.CallExpression {
    return preserveSourceMapRange(
      this.#factory.createCallExpression(
        this.getHelperExpr(name, originalNode),
        typeArguments,
        argumentsArray,
      ),
      originalNode,
    );
  }

  /**
   * Returns a `QualifiedName` for the requested helper name, e.g.
   * `__cfHelpers.JSONSchema`.
   */
  getHelperQualified(
    name: string,
  ): ts.QualifiedName {
    if (!this.sourceHasHelpers()) {
      throw new Error("Source file does not contain helpers.");
    }
    return this.#factory.createQualifiedName(
      this.#helperIdent!,
      name,
    );
  }
}

// The first-content-line scan lives in runtime-contract.ts (typescript-free,
// runtime-importable); re-exported here for the existing compile-side callers.
export { findFirstContentLineIndex } from "./runtime-contract.ts";
import { findFirstContentLineIndex } from "./runtime-contract.ts";

// Inject helpers so the AST transformer pipeline has access to helpers like
// `lift`.
// This operates on strings, and to be used outside of
// the TypeScript transformer pipeline, since symbol binding
// occurs before transformers run.
//
// We must also inject a usage of the module before the AST transformer
// pipeline, otherwise the import is elided at emit and the helper module is
// not available in the compiled JS. By default that usage is a forwarding
// `h(...)` function delegating to `__cfHelpers.h`, which also lets authors
// call `h` explicitly without importing it. JSX itself does not depend on the
// shim: the js-compiler emits elements and fragments against `__cfHelpers.h`
// directly (its `jsxFactory` / `jsxFragmentFactory`). When the authored
// module already binds `h` at top level, the shim would collide with that
// binding, so a bare `void __cfHelpers;` usage is appended instead and the
// author's `h` keeps its meaning.
//
// Source maps are derived from this transformation.
// Take care in maintaining source lines from its input.
//
// This injected statement enables subsequent transformations.
export function transformCfDirective(
  source: string,
  // Authored file name; when it has a JavaScript extension the injected
  // helper statement uses JS-only syntax. Defaults to TypeScript syntax.
  fileName?: string,
): string {
  const lines = source.split("\n");
  const firstContentLineIndex = findFirstContentLineIndex(lines);
  if (firstContentLineIndex === null) {
    return source;
  }

  return injectCfHelpers(source, fileName);
}

const JS_FILE_RE = /\.(js|jsx|mjs|cjs)$/;

export function injectCfHelpers(source: string, fileName?: string): string {
  const sourceFile = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.ES2023,
  );
  checkReservedHelperVar(sourceFile, CF_HELPERS_IDENTIFIER);
  const usedStmt = declaresTopLevelBinding(sourceFile, JSX_FACTORY_SHIM_NAME)
    ? HELPERS_USED_STMT_BARE
    : fileName !== undefined && JS_FILE_RE.test(fileName)
    ? HELPERS_USED_STMT_JS
    : HELPERS_USED_STMT;
  return [
    HELPERS_STMT,
    source,
    usedStmt,
  ].join("\n");
}

/**
 * Exact-envelope detector for LEGACY stored pattern sources (CT-1838).
 *
 * Pre-#4158 pipelines persisted the helper-INJECTED pretransform form as the
 * source-of-record: `[HELPERS_STMT, source, usedStmt].join("\n")`. Such a
 * document is byte-recognizable — its first line is exactly
 * {@link HELPERS_STMT} and it ends with the {@link HELPERS_USED_STMT} (or
 * {@link HELPERS_USED_STMT_JS}) trailer. The current authoring guard
 * (`checkCFHelperVar`) rejects the reserved `__cfHelpers` identifier, so
 * without tolerance every pre-#4158 stored pattern bricks on cold load —
 * and, via the default pattern, all piece creation in aged spaces.
 *
 * Match rules (deliberately exact — see the runner's cold-load call sites):
 * - prefix: line 1 must be byte-exactly `HELPERS_STMT`;
 * - trailer: the document must end with `"\n" + HELPERS_USED_STMT` or
 *   `"\n" + HELPERS_USED_STMT_JS` (both constants end in `"\n"`; a stripped
 *   final newline is tolerated);
 * - the prefix and trailer must not overlap.
 *
 * The bare-use trailer ({@link HELPERS_USED_STMT_BARE}) postdates #4158 and
 * is never persisted, so it is deliberately not a legacy trailer.
 *
 * Interior `__cfHelpers` occurrences inside a valid envelope DO match: the
 * predicate is prefix+suffix only. That is chosen behavior — `__cfHelpers`
 * grants nothing beyond what injection gives every pattern, and tolerance is
 * only ever applied to Merkle-verified stored input, never to authored
 * writes (all authoring paths keep throwing via `checkCFHelperVar`).
 *
 * NOTE: the export name and home (this module, next to the constants it
 * matches) are a compatibility contract — downstream vendoring gates import
 * `isLegacyInjectedEnvelope` from `cf-helpers.ts` to probe whether a runtime
 * candidate tolerates legacy stored envelopes. Do not rename or move.
 */
export function isLegacyInjectedEnvelope(source: string): boolean {
  const prefix = HELPERS_STMT + "\n";
  if (!source.startsWith(prefix)) return false;
  for (const stmt of [HELPERS_USED_STMT, HELPERS_USED_STMT_JS]) {
    // `stmt` ends with "\n": accept the stored form both with and without
    // that final newline (storage/tooling may have trimmed it).
    for (const trailer of ["\n" + stmt, ("\n" + stmt).slice(0, -1)]) {
      if (
        source.length >= prefix.length + trailer.length &&
        source.endsWith(trailer)
      ) {
        return true;
      }
    }
  }
  return false;
}

// Throws if `identifier` (the reserved `__cfHelpers`) was found as an
// Identifier anywhere in the parsed source.
function checkReservedHelperVar(sourceFile: ts.SourceFile, identifier: string) {
  const visitor = (node: ts.Node): ts.Node => {
    if (ts.isIdentifier(node) && node.text === identifier) {
      throw new Error(
        `Source cannot contain reserved helper symbol '${identifier}'.`,
      );
    }
    return ts.visitEachChild(node, visitor, undefined);
  };
  ts.visitNode(sourceFile, visitor);
}

// Whether a top-level statement of `sourceFile` declares a value binding named
// `name`: a function, class, enum, or namespace declaration, a variable
// declaration (destructuring included), or an import binding. Type-only
// declarations (`interface`, `type`) do not count: they occupy no value
// declaration space, so the function shim coexists with them. Bindings nested
// in any inner scope do not count either; they merely shadow the shim.
function declaresTopLevelBinding(
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  const isName = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isIdentifier(node) && node.text === name;
  const bindsName = (binding: ts.BindingName): boolean => {
    if (ts.isIdentifier(binding)) return binding.text === name;
    for (const element of binding.elements) {
      if (!ts.isOmittedExpression(element) && bindsName(element.name)) {
        return true;
      }
    }
    return false;
  };
  for (const stmt of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt)
    ) {
      if (isName(stmt.name)) return true;
    } else if (ts.isVariableStatement(stmt)) {
      for (const declaration of stmt.declarationList.declarations) {
        if (bindsName(declaration.name)) return true;
      }
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const { name, namedBindings } = stmt.importClause;
      if (isName(name)) return true;
      if (namedBindings === undefined) continue;
      if (ts.isNamespaceImport(namedBindings)) {
        if (isName(namedBindings.name)) return true;
      } else {
        for (const element of namedBindings.elements) {
          if (isName(element.name)) return true;
        }
      }
    }
  }
  return false;
}

function getCFHelpersIdentifier(
  statement: ts.Statement,
): ts.Identifier | undefined {
  if (!ts.isImportDeclaration(statement)) return;
  const { importClause, moduleSpecifier } = statement;

  // Check specifier is "commonfabric"
  if (!ts.isStringLiteral(moduleSpecifier)) return;
  if (moduleSpecifier.text !== CF_HELPERS_SPECIFIER) return;

  // Check it imports the internal `__cfHelpers` binding from commonfabric.
  if (!importClause || !ts.isImportClause(importClause)) return;
  const { namedBindings } = importClause;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
  for (const element of namedBindings.elements) {
    const bindingName = element.propertyName ?? element.name;
    if (bindingName.text === CF_HELPERS_IDENTIFIER) {
      return element.name;
    }
  }
  return;
}
