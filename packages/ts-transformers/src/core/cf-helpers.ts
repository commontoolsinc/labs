import ts from "typescript";
import { TransformationContext } from "./mod.ts";

export const CF_HELPERS_IDENTIFIER = "__cfHelpers";
export const CF_DATA_HELPER_IDENTIFIER = "__cfDataHelper";

const CF_HELPERS_SPECIFIER = "commonfabric";

// Runner pattern coverage line remapping treats this helper import as a
// one-line prelude. Changes to its line count need a matching update in
// patternCoverageOptionsForCompile.
const HELPERS_STMT =
  `import { ${CF_HELPERS_IDENTIFIER} } from "${CF_HELPERS_SPECIFIER}";`;

const HELPERS_USED_STMT = `// @ts-ignore: Internals
function h(...args: any[]) { return ${CF_HELPERS_IDENTIFIER}.h.apply(null, args); }
`;
// Syntax-neutral variant injected into authored `.js`/`.jsx` sources, where the
// `: any[]` annotation above would be a parse error ("Type annotations can only
// be used in TypeScript files"). Keep both statements line-for-line identical
// so injection shifts source lines the same way regardless of file kind.
const HELPERS_USED_STMT_JS = `// @ts-ignore: Internals
function h(...args) { return ${CF_HELPERS_IDENTIFIER}.h.apply(null, args); }
`;

export class CFHelpers {
  #sourceFile: ts.SourceFile;
  #factory: ts.NodeFactory;
  #helperIdent?: ts.Identifier;
  #dataHelperIdent?: ts.Identifier;

  constructor(params: Pick<TransformationContext, "sourceFile" | "factory">) {
    this.#sourceFile = params.sourceFile;
    this.#factory = params.factory;

    for (const stmt of this.#sourceFile.statements) {
      const helperSymbol = getCFHelpersIdentifier(stmt);
      if (helperSymbol) {
        this.#helperIdent = helperSymbol;
      }

      const dataHelperSymbol = getCFDataHelperIdentifier(stmt);
      if (dataHelperSymbol) {
        this.#dataHelperIdent = dataHelperSymbol;
      }
    }
  }

  sourceHasHelpers(): boolean {
    return !!this.#helperIdent;
  }

  sourceHasDataHelper(): boolean {
    return !!this.#dataHelperIdent;
  }

  // Returns an PropertyAccessExpression of the requested
  // helper name e.g. `(__cfHelpers.lift)`.
  preserveNodeSourceMap<T extends ts.Node>(
    node: T,
    originalNode: ts.Node,
    identityNode?: ts.Node,
  ): T {
    const sourceMapRange = ts.getSourceMapRange(originalNode) ?? originalNode;
    const preserved = ts.setSourceMapRange(node, sourceMapRange);
    return identityNode
      ? ts.setOriginalNode(preserved, identityNode) as T
      : preserved as T;
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
    const helperName = this.preserveNodeSourceMap(
      this.#factory.createIdentifier(name),
      originalNode,
    );
    return this.preserveNodeSourceMap(
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
    return this.preserveNodeSourceMap(
      this.#factory.createCallExpression(
        this.getHelperExpr(name, originalNode),
        typeArguments,
        argumentsArray,
      ),
      originalNode,
    );
  }

  // Returns an QualifiedName of the requested
  // helper name e.g. `__cfHelpers.JSONSchema`.
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

  getDataHelperExpr(originalNode?: ts.Node): ts.Identifier {
    if (!this.sourceHasDataHelper()) {
      throw new Error("Source file does not contain __cfDataHelper.");
    }

    if (!originalNode) {
      return this.#factory.createIdentifier(this.#dataHelperIdent!.text);
    }

    return this.preserveNodeSourceMap(
      this.#factory.createIdentifier(this.#dataHelperIdent!.text),
      originalNode,
      this.#dataHelperIdent!,
    );
  }
}

// The disable-directive check lives in runtime-contract.ts (typescript-free,
// runtime-importable); re-exported here for the existing compile-side callers.
export {
  findFirstContentLineIndex,
  sourceDisablesCfTransform,
  sourceHasIgnoredDisableDirective,
} from "./runtime-contract.ts";
import {
  findFirstContentLineIndex,
  sourceDisablesCfTransform,
} from "./runtime-contract.ts";

// Rewrite a leading transform directive line, or inject helpers by default,
// so the AST transformer pipeline has access to helpers like `lift`.
// This operates on strings, and to be used outside of
// the TypeScript transformer pipeline, since symbol binding
// occurs before transformers run.
//
// We must also inject usage of the module before the AST transformer
// pipeline, otherwise the binding fails, and the helper module
// is not available in the compiled JS. We repropagate the jsx `h`
// function, which allows authors to not manually specify the import,
// as well as "use" the helper to avoid treeshaking/binding failure.
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
  checkCFHelperVar(source);

  const lines = source.split("\n");
  const firstContentLineIndex = findFirstContentLineIndex(lines);
  if (firstContentLineIndex === null) {
    return source;
  }

  if (sourceDisablesCfTransform(source)) {
    return [
      ...lines.slice(0, firstContentLineIndex),
      "",
      ...lines.slice(firstContentLineIndex + 1),
    ].join("\n");
  }

  return injectCfHelpers(source, fileName);
}

const JS_FILE_RE = /\.(js|jsx|mjs|cjs)$/;

export function injectCfHelpers(source: string, fileName?: string): string {
  checkCFHelperVar(source);
  const usedStmt = fileName !== undefined && JS_FILE_RE.test(fileName)
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

// Throws if `__cfHelpers` was found as an Identifier
// in the source code.
function checkCFHelperVar(source: string) {
  checkReservedHelperVar(source, CF_HELPERS_IDENTIFIER);
}

function checkReservedHelperVar(source: string, identifier: string) {
  const sourceFile = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.ES2023,
  );
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

function getCFDataHelperIdentifier(
  statement: ts.Statement,
): ts.Identifier | undefined {
  if (!ts.isImportDeclaration(statement)) return;
  const { importClause, moduleSpecifier } = statement;

  if (!ts.isStringLiteral(moduleSpecifier)) return;
  if (moduleSpecifier.text !== CF_HELPERS_SPECIFIER) return;

  if (!importClause || !ts.isImportClause(importClause)) return;
  const { namedBindings } = importClause;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
  for (const element of namedBindings.elements) {
    if (element.name.text !== CF_DATA_HELPER_IDENTIFIER) {
      continue;
    }
    if ((element.propertyName ?? element.name).text !== "__cf_data") {
      continue;
    }
    return element.name;
  }
  return;
}
