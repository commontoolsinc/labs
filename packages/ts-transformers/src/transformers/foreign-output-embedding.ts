import ts from "typescript";
import { detectCallKind, getTypeFromTypeNodeWithFallback } from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";

/**
 * Foreign-output embedding check (prototype for the verb-evolution brief,
 * PR #5682).
 *
 * A pattern that stores pieces of another pattern and types them with that
 * pattern's own Output type embeds the provider's WHOLE contract — verbs
 * included — into its own schema. The update gate then refuses the provider's
 * most ordinary evolution step (adding a verb) as a change to the *holder*.
 * The documented alternative is a consumer-owned narrow type: declare only
 * the fields read and the verbs called (composition.md, "Keep External Data
 * Contracts Narrow").
 *
 * The unenforceable spelling of that rule is "don't export your Output type"
 * — export is required for factory nameability, and the refusal reproduces
 * same-file with no import at all. The enforceable spelling is checked here:
 * no pattern's argument or result schema may embed a type that is the
 * Output-position type argument of a DIFFERENT pattern factory call anywhere
 * in the program.
 *
 * Self-reference stays legal (a TreeNode whose children are TreeNodeOutput[]
 * is the documented shape), and a provider can opt a type out with a
 * `@sharedContract` JSDoc tag when the type itself is the intended protocol.
 *
 * Severity is "warning" while this is a prototype: it surfaces the coupling
 * without failing anyone's build.
 */

export const FOREIGN_OUTPUT_EMBEDDING_DIAGNOSTIC =
  "contract:foreign-output-embedding";

const SHARED_CONTRACT_TAG = "sharedContract";

const WALK_DEPTH_LIMIT = 8;

interface IndexedOutput {
  readonly typeName: string;
  readonly fileName: string;
}

type OutputSymbolIndex = Map<ts.Symbol, IndexedOutput>;

const indexCache = new WeakMap<ts.Program, OutputSymbolIndex>();

/** Resolve the named symbol a type-argument node refers to, if any. */
function namedSymbolForTypeNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (!ts.isTypeReferenceNode(node)) return undefined;
  return namedSymbolForType(getTypeFromTypeNodeWithFallback(node, checker));
}

function namedSymbolForType(type: ts.Type): ts.Symbol | undefined {
  const withInternals = type as ts.Type & { aliasSymbol?: ts.Symbol };
  const symbol = withInternals.aliasSymbol ?? type.getSymbol();
  // Anonymous shapes (inline literals, `__type`/`__object`) have no name to
  // hold anyone to, and a symbol without declarations has no tag to read.
  if (
    !symbol || symbol.name === "__type" || symbol.name === "__object" ||
    !symbol.declarations || symbol.declarations.length === 0
  ) {
    return undefined;
  }
  return symbol;
}

function hasSharedContractTag(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) =>
    ts.getJSDocTags(declaration).some(
      (tag) => tag.tagName.text === SHARED_CONTRACT_TAG,
    )
  );
}

/**
 * Collect the Output-position symbol of every pattern factory call in the
 * program. Cached per program: the set is a fact about the whole compile,
 * not about the file currently being transformed.
 */
function outputSymbolIndex(
  program: ts.Program,
  checker: ts.TypeChecker,
): OutputSymbolIndex {
  const cached = indexCache.get(program);
  if (cached) return cached;

  const index: OutputSymbolIndex = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.typeArguments && node.typeArguments.length > 0
      ) {
        const callKind = detectCallKind(node, checker);
        if (
          callKind?.kind === "builder" && callKind.builderName === "pattern"
        ) {
          // `pattern<Input, Output>` — Output rides second; `pattern<T>` —
          // T serves both positions. The guard above proves one exists.
          const outputNode = node.typeArguments[1] ?? node.typeArguments[0]!;
          const symbol = namedSymbolForTypeNode(outputNode, checker);
          if (symbol && !hasSharedContractTag(symbol)) {
            index.set(symbol, {
              typeName: symbol.name,
              fileName: sourceFile.fileName,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  indexCache.set(program, index);
  return index;
}

interface EmbeddingHit {
  readonly symbol: ts.Symbol;
  readonly info: IndexedOutput;
}

/**
 * Walk a type's reachable structure looking for references to indexed Output
 * symbols. Stops at the first hit per symbol and does not recurse into a hit
 * — one report per foreign type is enough, and its members are the
 * provider's business.
 */
function collectEmbeddingHits(
  root: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
  index: OutputSymbolIndex,
  ownSymbols: ReadonlySet<ts.Symbol>,
): EmbeddingHit[] {
  const hits = new Map<ts.Symbol, EmbeddingHit>();
  const visited = new Set<ts.Type>();

  const visit = (type: ts.Type, depth: number): void => {
    if (depth > WALK_DEPTH_LIMIT || visited.has(type)) return;
    visited.add(type);

    const symbol = namedSymbolForType(type);
    if (symbol && index.has(symbol) && !ownSymbols.has(symbol)) {
      if (!hits.has(symbol)) {
        hits.set(symbol, { symbol, info: index.get(symbol)! });
      }
      return;
    }

    if (type.isUnionOrIntersection()) {
      for (const member of type.types) visit(member, depth + 1);
      return;
    }

    const withInternals = type as ts.Type & {
      aliasTypeArguments?: readonly ts.Type[];
    };
    for (const argument of withInternals.aliasTypeArguments ?? []) {
      visit(argument, depth + 1);
    }

    if (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
    ) {
      for (
        const argument of checker.getTypeArguments(type as ts.TypeReference)
      ) {
        visit(argument, depth + 1);
      }
    }

    if ((type.flags & ts.TypeFlags.Object) !== 0) {
      for (const property of checker.getPropertiesOfType(type)) {
        visit(checker.getTypeOfSymbolAtLocation(property, location), depth + 1);
      }
    }
  };

  visit(root, 0);
  return [...hits.values()];
}

/** Best-effort syntactic anchor: the reference node that names the symbol. */
function referenceNodeForSymbol(
  typeNode: ts.TypeNode,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isTypeReferenceNode(node) &&
      namedSymbolForTypeNode(node, checker) === symbol
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(typeNode);
  return found;
}

export interface ForeignOutputEmbeddingCheckInput {
  readonly context: TransformationContext;
  readonly callNode: ts.CallExpression;
  readonly inputType: ts.Type | undefined;
  readonly inputTypeNode: ts.TypeNode;
  readonly resultType: ts.Type | undefined;
  readonly resultTypeNode: ts.TypeNode;
}

/**
 * Report a warning for every foreign pattern Output type embedded in this
 * pattern call's argument or result contract.
 */
export function checkForeignOutputEmbedding(
  input: ForeignOutputEmbeddingCheckInput,
): void {
  const { context, callNode } = input;
  const { checker, program } = context;

  const index = outputSymbolIndex(program, checker);
  if (index.size === 0) return;

  const ownSymbols = new Set<ts.Symbol>();
  for (const typeArg of callNode.typeArguments ?? []) {
    const symbol = namedSymbolForTypeNode(typeArg, checker);
    if (symbol) ownSymbols.add(symbol);
  }

  const sides: ReadonlyArray<{
    role: "argument" | "result";
    type: ts.Type | undefined;
    typeNode: ts.TypeNode;
  }> = [
    { role: "argument", type: input.inputType, typeNode: input.inputTypeNode },
    { role: "result", type: input.resultType, typeNode: input.resultTypeNode },
  ];

  for (const side of sides) {
    const type = side.type ??
      getTypeFromTypeNodeWithFallback(side.typeNode, checker);

    const hits = collectEmbeddingHits(
      type,
      checker,
      callNode,
      index,
      ownSymbols,
    );
    for (const hit of hits) {
      const anchor =
        referenceNodeForSymbol(side.typeNode, hit.symbol, checker) ?? callNode;
      context.reportDiagnosticOnce({
        severity: "warning",
        type: FOREIGN_OUTPUT_EMBEDDING_DIAGNOSTIC,
        node: anchor,
        message: `Pattern ${side.role} embeds ${hit.info.typeName}, the ` +
          `output type of another pattern. A holder should declare only its ` +
          `demand — the fields it reads and the verbs it calls — as its own ` +
          `narrow type (optionally marked Demand<T>); embedding the full ` +
          `output ties this pattern's update gate to the provider's whole ` +
          `shape. If ${hit.info.typeName} is itself the intended shared ` +
          `protocol, tag its declaration @sharedContract.`,
      });
    }
  }
}
