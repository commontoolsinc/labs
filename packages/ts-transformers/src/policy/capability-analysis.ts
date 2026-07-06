import ts from "typescript";
import {
  MERGEABLE_OP_METHODS,
  type MergeableOpMethodKind,
} from "@commonfabric/api";
import {
  classifyArrayCallbackContainerCall,
  getNodeText,
  isCellLikeType,
  isWildcardTraversalCall,
} from "../ast/mod.ts";
import {
  type CapabilityParamSummary,
  type FunctionCapabilitySummary,
  type ReactiveCapability,
  resolvesToCommonFabricSymbol,
  type UnreadableCellArgument,
} from "../core/mod.ts";
import { isBrandedCellType } from "../transformers/cell-type.ts";
import { type CellBrand } from "@commonfabric/schema-generator/cell-brand";
import { getKnownComputedKeyPathSegment } from "../utils/reactive-keys.ts";
import { decodePath, encodePath } from "../utils/path-serialization.ts";
import { unwrapExpression } from "../utils/expression.ts";
import {
  createMergeablePushClassifier,
  type MergeableCollectionSite,
  type MergeablePushMisuse,
} from "./mergeable-push-classification.ts";

type CapabilityAnalyzableFunction =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration;

export interface CapabilityAnalysisOptions {
  readonly checker?: ts.TypeChecker;
  readonly interprocedural?: boolean;
  readonly includeNestedCallbacks?: boolean;
  readonly summaryCache?: WeakMap<ts.Node, FunctionCapabilitySummary>;
  readonly inProgress?: WeakSet<ts.Node>;
  /**
   * Transformer-known types for nodes the checker can't resolve. Required for
   * synthetic callbacks (e.g. the destructure-lowered lift-applied param, whose
   * bindings type as `any`): without it, type-based heuristics like
   * `isPrimitiveLikeExpression` answer wrong in a fixed direction and the
   * capability summary mis-shapes or drops inputs. Consulted before the checker.
   */
  readonly typeRegistry?: WeakMap<ts.Node, ts.Type>;
  /**
   * Optional sink for the read-then-mergeable-`push` misuse check. When set,
   * the analysis reports each `Cell.push` whose receiver collection path the
   * same function also reads explicitly (a `.get()` or an iteration), classified
   * by how that read relates to the push (see
   * {@link MergeablePushMisuse.kind}): a push that depends on the read through
   * a guard or its value is the dedup-then-push shape, better expressed as an
   * identity-addressed `addUnique` or a read-modify-write `set`; a read that
   * instead feeds an independent write to the same collection keeps the append
   * conflict-prone and belongs in its own handler. A read unrelated to both is
   * not reported. Left unset (the default), the analysis records no push sites.
   */
  readonly mergeablePushMisuseSink?: (finding: MergeablePushMisuse) => void;
}

interface MutableCapabilityState {
  readonly reads: Set<string>;
  readonly fullShapeReads: Set<string>;
  readonly writes: Set<string>;
  readonly rawIdentityPaths: Set<string>;
  readonly rawIdentityCellPaths: Set<string>;
  readonly rawComparablePaths: Set<string>;
  readonly rawComparableCellPaths: Set<string>;
  readonly rawOpaquePaths: Set<string>;
  passthrough: boolean;
  wildcard: boolean;
  hasIdentityUse: boolean;
  hasNonIdentityUse: boolean;
  hasNonIdentityRootUse: boolean;
  /**
   * An unrecognized method was called on a cell-like receiver rooted in this
   * parameter. The call could be a mutator this analysis does not know, so
   * `writes` cannot be treated as exhaustive — consumers asserting write
   * exhaustiveness must fail closed on this, like `wildcard`; recognized
   * reads/derivations are unaffected.
   */
  hasUnverifiedCellUse: boolean;
}

interface ObservedCapabilityUsage {
  readonly readPaths: readonly (readonly string[])[];
  readonly fullShapePaths: readonly (readonly string[])[];
  readonly writePaths: readonly (readonly string[])[];
  readonly opaquePaths: readonly (readonly string[])[];
  readonly passthrough: boolean;
  readonly wildcard: boolean;
  readonly hasUnverifiedCellUse: boolean;
  readonly identityOnly: boolean;
  readonly identityPaths: readonly (readonly string[])[];
  readonly identityCellPaths: readonly (readonly string[])[];
  readonly comparablePaths: readonly (readonly string[])[];
  readonly comparableCellPaths: readonly (readonly string[])[];
}

interface AccessPathInfo {
  readonly root: string;
  readonly path: readonly string[];
  readonly dynamic: boolean;
  readonly optional: boolean;
}

interface SourceRef {
  readonly root: string;
  readonly path: readonly string[];
  readonly dynamic: boolean;
  readonly arrayElement?: boolean;
  readonly elementResult?: boolean;
}

interface AliasShape {
  readonly properties: ReadonlyMap<string, AliasBinding>;
}

type AliasBinding = SourceRef | AliasShape;

function materializeSourceRef(ref: SourceRef): SourceRef {
  if (!ref.arrayElement) {
    return ref;
  }
  return {
    root: ref.root,
    path: [...ref.path, "0"],
    dynamic: ref.dynamic,
    elementResult: ref.elementResult,
  };
}

function extendSourceRef(
  ref: SourceRef,
  path: readonly string[],
): SourceRef {
  const base = materializeSourceRef(ref);
  return {
    root: base.root,
    path: [...base.path, ...path],
    dynamic: base.dynamic,
    elementResult: base.elementResult && path.length === 0,
  };
}

const PARAMETER_SUMMARY_PREFIX = "__param";

// The mergeable-op writer methods (increment, push, addUnique, removeByValue)
// come from the canonical catalog in @commonfabric/api, so a new mergeable op is
// classified by registering it there — no edit here. The non-mergeable Cell
// writers stay listed explicitly.
const mergeableMethods = (kind: MergeableOpMethodKind): string[] =>
  MERGEABLE_OP_METHODS.filter((op) => op.kind === kind).map((op) => op.method);

// `send` is a write: at runtime Stream.send() delegates to set() (an event
// enqueue is a write to the stream cell). Classifying it here keeps
// writePaths an honest record of capture writes — a callback that fires
// events during evaluation must never summarize as write-free.
const WRITER_METHODS = new Set([
  "set",
  "update",
  "send",
  ...mergeableMethods("scalar-writer"),
]);
const ARRAY_IDENTITY_WRITER_METHODS = new Set([
  "unshift",
  "splice",
  "remove",
  "removeAll",
  ...mergeableMethods("array-identity-writer"),
]);
const ARRAY_IDENTITY_PRESERVING_CHAIN_METHODS = new Set(["slice"]);
// The mergeable tail-append op. Only `push` commits as a mergeable `append`
// that drops the op's own array read from conflict detection; a handler that
// also reads the same collection then has a fragile read-then-push shape. The
// other identity writers either dedup/remove by value (the recommended
// replacements) or are ordinary read-modify-writes, so they are not flagged.
const MERGEABLE_APPEND_METHODS = new Set(["push"]);
const READER_METHODS = new Set(["get"]);
const OPAQUE_DERIVATION_METHODS = new Set([
  "map",
  "mapWithPattern",
  "flatMap",
  "flatMapWithPattern",
  "filter",
  "filterWithPattern",
]);
const FALLBACK_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
]);
const PRECISE_CHAIN_METHODS = new Set([
  "map",
  "mapWithPattern",
  "filter",
  "filterWithPattern",
  "flatMap",
  "flatMapWithPattern",
  "sort",
  "toSorted",
  "find",
  "findLast",
  "at",
]);
const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

function isCapabilityAnalyzableFunction(
  node: ts.Node | undefined,
): node is CapabilityAnalyzableFunction {
  return !!node &&
    (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node)
    ) &&
    !!node.body;
}

function isInterproceduralSummaryTarget(
  declaration: ts.Node | undefined,
  sourceFile: ts.SourceFile,
): declaration is CapabilityAnalyzableFunction {
  return isCapabilityAnalyzableFunction(declaration) &&
    declaration.getSourceFile() === sourceFile;
}

// Body analysis cannot see writes performed inside a callee whose body lives in
// another file. The callee's declared parameter type is the only available
// description of what it does with the cell, so it is treated as a contract for
// the one capability the body cannot reveal: a hidden write.
function isSignatureDeclaredOutsideSourceFile(
  signature: ts.Signature,
  sourceFile: ts.SourceFile,
): boolean {
  const declaration = signature.declaration;
  return !!declaration && declaration.getSourceFile() !== sourceFile;
}

function getParameterAtArgument(
  signature: ts.Signature,
  argumentIndex: number,
): ts.Symbol | undefined {
  const parameters = signature.getParameters();
  if (argumentIndex < parameters.length) {
    return parameters[argumentIndex];
  }
  const lastParameter = parameters[parameters.length - 1];
  const declaration = lastParameter?.valueDeclaration;
  return declaration && ts.isParameter(declaration) &&
      declaration.dotDotDotToken
    ? lastParameter
    : undefined;
}

// Read the capability an imported callee declares for a parameter from its
// Common Fabric cell wrapper type. `Writable<T>` is a structural alias of
// `Cell<T>` (an identical type), so the two are distinguished only by the
// spelling on the declared type node; the wrapper is matched nominally, by name,
// rather than by the resolved type. The other wrappers (`ReadonlyCell`,
// `WriteonlyCell`, etc.) carry distinct brands and are genuinely different
// types. A type that is not a recognized Common Fabric wrapper returns undefined
// and leaves the conservative default in place.
// In a union type node, `undefined` parses as a keyword type node but `null`
// parses as a LiteralTypeNode wrapping a null literal, so a bare NullKeyword
// check never matches. Skip both so a nullable wrapper such as
// `Writable<T> | null` is still recognized by its non-null member.
function isNullOrUndefinedTypeNode(typeNode: ts.TypeNode): boolean {
  if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  return ts.isLiteralTypeNode(typeNode) &&
    typeNode.literal.kind === ts.SyntaxKind.NullKeyword;
}

// A bounded generic parameter (`<C extends Writable<T>>`) carries the capability
// of its constraint, so read the constraint node. Unbounded generics have no
// constraint and stay unreadable.
function getTypeParameterConstraintTypeNode(
  symbol: ts.Symbol | undefined,
): ts.TypeNode | undefined {
  for (const declaration of symbol?.getDeclarations() ?? []) {
    if (ts.isTypeParameterDeclaration(declaration) && declaration.constraint) {
      return declaration.constraint;
    }
  }
  return undefined;
}

function getExplicitCellKindFromTypeNode(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  depth = 0,
): CellBrand | undefined {
  // The depth guard bounds the type-parameter-constraint recursion below
  // against a circular constraint on ill-typed input.
  if (!typeNode || depth > 16) return undefined;

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return getExplicitCellKindFromTypeNode(typeNode.type, checker, depth + 1);
  }

  if (ts.isUnionTypeNode(typeNode)) {
    const kinds = new Set<CellBrand>();
    for (const member of typeNode.types) {
      if (isNullOrUndefinedTypeNode(member)) {
        continue;
      }
      const kind = getExplicitCellKindFromTypeNode(member, checker, depth + 1);
      if (!kind) {
        return undefined;
      }
      kinds.add(kind);
    }
    return kinds.size === 1 ? kinds.values().next().value : undefined;
  }

  if (!ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(typeNode.typeName);
  // `Writable<T>` is the spelling that declares write intent. Bare `Cell<T>` is
  // the neutral base alias and is intentionally not matched here: a callee that
  // writes a cell argument must declare `Writable<T>` (or `WriteonlyCell<T>`),
  // so an ambiguous `Cell<T>` parameter stays conservative and does not grant
  // the caller write authority it has not demonstrated.
  if (resolvesToCommonFabricSymbol(symbol, checker, "Writable")) {
    return "cell";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "ReadonlyCell")) {
    return "readonly";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "WriteonlyCell")) {
    return "writeonly";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "Stream")) {
    return "stream";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "ComparableCell")) {
    return "comparable";
  }
  if (
    resolvesToCommonFabricSymbol(symbol, checker, "OpaqueCell") ||
    resolvesToCommonFabricSymbol(symbol, checker, "OpaqueRef")
  ) {
    return "opaque";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "SqliteDb")) {
    return "sqlite";
  }
  const constraint = getTypeParameterConstraintTypeNode(symbol);
  if (constraint) {
    return getExplicitCellKindFromTypeNode(constraint, checker, depth + 1);
  }
  return undefined;
}

// The declared type node that governs a single argument at this parameter: the
// element type for a rest parameter, otherwise the parameter's own type.
function getEffectiveParameterTypeNode(
  parameter: ts.Symbol | undefined,
): ts.TypeNode | undefined {
  const declaration = parameter?.valueDeclaration;
  if (!declaration || !ts.isParameter(declaration)) {
    return undefined;
  }
  if (declaration.dotDotDotToken) {
    return getRestParameterElementTypeNode(declaration.type);
  }
  return declaration.type;
}

function getParameterDeclaredCellKind(
  parameter: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): CellBrand | undefined {
  return getExplicitCellKindFromTypeNode(
    getEffectiveParameterTypeNode(parameter),
    checker,
  );
}

// A missing annotation (implicit any) or an explicit `any`/`unknown` parameter
// A union parameter that mixes a recognized cell wrapper with a member the
// contract cannot collapse to the same capability — for example
// `AuthCell | Writable<Auth>`, or `Writable<Auth> | ReadonlyCell<Auth>`. Such a
// union defeats classification: overload resolution can't pick the intended
// capability, so a cell argument silently degrades. This is deliberately narrow
// — it does not fire for value-or-cell framework types (`FactoryInput<T>`,
// `U | AnyBrandedCell<U>`), which are unions with no recognized-wrapper member
// (or not unions at all), nor for bare `Cell<T>`, generics, or `any`/`unknown`.
function isAmbiguousCellWrapperUnion(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): boolean {
  let node = typeNode;
  while (node && ts.isParenthesizedTypeNode(node)) {
    node = node.type;
  }
  if (!node || !ts.isUnionTypeNode(node)) return false;
  // If the union collapses to a single capability it is readable; only flag when
  // it does not, yet at least one member is a recognized cell wrapper.
  if (getExplicitCellKindFromTypeNode(node, checker)) return false;
  return node.types.some((member) =>
    !isNullOrUndefinedTypeNode(member) &&
    getExplicitCellKindFromTypeNode(member, checker) !== undefined
  );
}

function buildUnreadableCellArgumentMessage(
  typeNode: ts.TypeNode | undefined,
): string {
  const typeText = typeNode ? getNodeText(typeNode) : "unknown";
  return `Cell argument flows to an imported parameter typed \`${typeText}\`, ` +
    `a union that mixes cell capabilities the analysis cannot resolve to one ` +
    `kind. Split the callee into overloads (one per cell wrapper, such as ` +
    `\`Writable<T>\` and the other type) so overload resolution selects the ` +
    `intended capability; otherwise the argument silently degrades to a ` +
    `read-only cell and a needed write is denied at runtime.`;
}

// A rest parameter declares an array, but each variadic argument has the
// element type. Unwrap `T[]`, `readonly T[]`, `Array<T>`, and `ReadonlyArray<T>`
// to the element.
function getRestParameterElementTypeNode(
  typeNode: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  if (!typeNode) return undefined;
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return getRestParameterElementTypeNode(typeNode.type);
  }
  if (
    ts.isTypeOperatorNode(typeNode) &&
    typeNode.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    return getRestParameterElementTypeNode(typeNode.type);
  }
  if (ts.isArrayTypeNode(typeNode)) {
    return typeNode.elementType;
  }
  if (
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    (typeNode.typeName.text === "Array" ||
      typeNode.typeName.text === "ReadonlyArray") &&
    typeNode.typeArguments?.length === 1
  ) {
    return typeNode.typeArguments[0];
  }
  return undefined;
}

function isRestParameter(parameter: ts.Symbol | undefined): boolean {
  const declaration = parameter?.valueDeclaration;
  return !!declaration && ts.isParameter(declaration) &&
    !!declaration.dotDotDotToken;
}

function isLiteralElement(
  expr: ts.Expression | undefined,
): expr is
  | ts.StringLiteral
  | ts.NumericLiteral
  | ts.NoSubstitutionTemplateLiteral {
  return !!expr &&
    (ts.isStringLiteral(expr) ||
      ts.isNumericLiteral(expr) ||
      ts.isNoSubstitutionTemplateLiteral(expr));
}

function getLiteralElementText(
  expr: ts.StringLiteral | ts.NumericLiteral | ts.NoSubstitutionTemplateLiteral,
): string {
  return expr.text;
}

function extractLiteralPathArguments(
  args: readonly ts.Expression[],
  checker?: ts.TypeChecker,
): { path: readonly string[]; dynamic: boolean } {
  const path: string[] = [];
  for (const arg of args) {
    if (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) {
      path.push(arg.text);
      continue;
    }
    if (ts.isNoSubstitutionTemplateLiteral(arg)) {
      path.push(arg.text);
      continue;
    }
    const knownKey = getKnownComputedKeyPathSegment(arg, checker);
    if (knownKey) {
      path.push(knownKey);
      continue;
    }
    return { path, dynamic: true };
  }
  return { path, dynamic: false };
}

function getStaticPropertyKeyText(
  name: ts.PropertyName,
  checker?: ts.TypeChecker,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  if (ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    return getKnownComputedKeyPathSegment(name.expression, checker) ??
      (isLiteralElement(name.expression)
        ? getLiteralElementText(name.expression)
        : undefined);
  }

  return undefined;
}

function extractAccessPath(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): AccessPathInfo | undefined {
  const path: string[] = [];
  let dynamic = false;
  let optional = false;
  let current: ts.Expression = unwrapExpression(expr);

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      optional ||= !!current.questionDotToken;
      current = unwrapExpression(current.expression);
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      optional ||= !!current.questionDotToken;
      if (isLiteralElement(current.argumentExpression)) {
        path.unshift(getLiteralElementText(current.argumentExpression));
      } else {
        const knownKey = current.argumentExpression &&
          getKnownComputedKeyPathSegment(current.argumentExpression, checker);
        if (knownKey) {
          path.unshift(knownKey);
        } else {
          dynamic = true;
        }
      }
      current = unwrapExpression(current.expression);
      continue;
    }

    break;
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  return {
    root: current.text,
    path,
    dynamic,
    optional,
  };
}

function isMemberRootIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

function isTopmostMemberNode(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  return !(
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isFunctionExpression(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  return false;
}

function isNonValueIdentifierUsage(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;

  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;

  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return ASSIGNMENT_OPERATORS.has(kind);
}

function isBooleanConditionUsage(expression: ts.Expression): boolean {
  const parent = expression.parent;
  if (!parent) return false;

  if (
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent)) &&
    parent.expression === expression
  ) {
    return isBooleanConditionUsage(parent);
  }

  if (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken &&
    parent.operand === expression
  ) {
    return isBooleanConditionUsage(parent);
  }

  if (
    (ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)) &&
    parent.expression === expression
  ) {
    return true;
  }

  if (ts.isConditionalExpression(parent) && parent.condition === expression) {
    return true;
  }

  if (ts.isForStatement(parent) && parent.condition === expression) {
    return true;
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === expression &&
    (
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
  ) {
    return true;
  }

  return false;
}

function unwrapIdentifierUsageSite(node: ts.Identifier): ts.Expression {
  let current: ts.Expression = node;
  while (true) {
    const parent = current.parent;
    if (!parent) {
      return current;
    }
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

function unwrapExpressionUsageSite(node: ts.Expression): ts.Expression {
  let current = node;
  while (true) {
    const parent = current.parent;
    if (!parent) {
      return current;
    }
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

function isPassThroughIdentifierUsage(node: ts.Identifier): boolean {
  const usage = unwrapIdentifierUsageSite(node);
  const parent = usage.parent;
  if (!parent) return false;

  if (ts.isArrowFunction(parent) && parent.body === usage) return true;
  if (ts.isReturnStatement(parent) && parent.expression === usage) return true;
  if (ts.isVariableDeclaration(parent) && parent.initializer === usage) {
    return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === usage) {
    return true;
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === usage) {
    return true;
  }
  if (ts.isArrayLiteralExpression(parent) && parent.elements.includes(usage)) {
    return true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === usage &&
    isAssignmentOperator(parent.operatorToken.kind)
  ) {
    return true;
  }

  return false;
}

function isCallOrNewArgumentUsage(
  usage: ts.Expression,
): boolean {
  const parent = usage.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent)) {
    return parent.arguments.includes(usage);
  }
  if (ts.isNewExpression(parent) && parent.arguments) {
    return parent.arguments.includes(usage);
  }
  return false;
}

function isArrayIdentityWriterArgumentUsage(
  usage: ts.Expression,
): boolean {
  const parent = usage.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return false;
  }
  if (!parent.arguments.includes(usage)) {
    return false;
  }
  const target = unwrapExpression(parent.expression);
  const methodName = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : ts.isElementAccessExpression(target) && target.argumentExpression &&
        isLiteralElement(target.argumentExpression)
    ? getLiteralElementText(target.argumentExpression)
    : undefined;
  return isArrayIdentityWriterValueArgument(methodName, parent, usage);
}

function isArrayIdentityWriterValueArgument(
  methodName: string | undefined,
  call: ts.CallExpression,
  usage: ts.Expression,
): boolean {
  if (!methodName || !ARRAY_IDENTITY_WRITER_METHODS.has(methodName)) {
    return false;
  }
  const index = call.arguments.findIndex((argument) => argument === usage);
  if (index < 0) {
    return false;
  }
  return methodName === "splice" ? index >= 2 : true;
}

function isOptionalAliasInitializerMemberUsage(usage: ts.Expression): boolean {
  let current: ts.Expression = usage;
  let sawOptionalMemberAccess = (ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)) && !!current.questionDotToken;
  while (current.parent) {
    const parent = current.parent;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    ) {
      sawOptionalMemberAccess ||= !!parent.questionDotToken;
      current = parent;
      continue;
    }
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    return sawOptionalMemberAccess && ts.isVariableDeclaration(parent) &&
      parent.initializer === current;
  }
  return false;
}

function getIdentityArrayLocalNameForElementUsage(
  usage: ts.Node,
): string | undefined {
  const parent = usage.parent;
  if (!parent || !ts.isArrayLiteralExpression(parent)) {
    return undefined;
  }

  let current: ts.Expression = parent;
  while (current.parent) {
    const parentNode = current.parent;
    if (
      (ts.isParenthesizedExpression(parentNode) ||
        ts.isAsExpression(parentNode) ||
        ts.isTypeAssertionExpression(parentNode) ||
        ts.isSatisfiesExpression(parentNode) ||
        ts.isNonNullExpression(parentNode)) &&
      parentNode.expression === current
    ) {
      current = parentNode;
      continue;
    }

    if (
      (ts.isPropertyAccessExpression(parentNode) ||
        ts.isElementAccessExpression(parentNode)) &&
      parentNode.expression === current
    ) {
      current = parentNode;
      continue;
    }

    if (
      ts.isCallExpression(parentNode) &&
      parentNode.expression === current
    ) {
      current = parentNode;
      continue;
    }

    if (
      ts.isVariableDeclaration(parentNode) &&
      parentNode.initializer === current &&
      ts.isIdentifier(parentNode.name)
    ) {
      return parentNode.name.text;
    }

    return undefined;
  }

  return undefined;
}

function getIdentityArrayLocalNameForWriterArgumentUsage(
  usage: ts.Expression,
): string | undefined {
  const parent = usage.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return undefined;
  }
  const target = unwrapExpression(parent.expression);
  const receiver = ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)
    ? unwrapExpression(target.expression)
    : undefined;
  const methodName = getCallMethodNameFromExpression(parent.expression);
  if (!receiver || !ts.isIdentifier(receiver)) {
    return undefined;
  }
  if (!isArrayIdentityWriterValueArgument(methodName, parent, usage)) {
    return undefined;
  }
  return receiver.text;
}

function collectArrayLocalsPassedToSet(
  body: ts.ConciseBody,
  checker?: ts.TypeChecker,
): ReadonlySet<string> {
  const arrayInitializerLocals = new Set<string>();
  const setArgumentLocals = new Set<string>();
  const structurallyAccessedArrayLocals = new Set<string>();

  const expressionIsIdentityArrayInitializer = (
    expression: ts.Expression,
  ): boolean => {
    const current = unwrapExpression(expression);
    if (ts.isArrayLiteralExpression(current)) {
      return true;
    }
    if (ts.isCallExpression(current)) {
      const target = unwrapExpression(current.expression);
      if (
        ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)
      ) {
        const methodName = getCallMethodNameFromExpression(current.expression);
        return !!methodName &&
          ARRAY_IDENTITY_PRESERVING_CHAIN_METHODS.has(methodName) &&
          expressionIsIdentityArrayInitializer(target.expression);
      }
    }
    return false;
  };

  const isCallReceiverForMethod = (
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    methods: ReadonlySet<string>,
  ): boolean => {
    const methodName = getCallMethodNameFromExpression(node);
    return !!methodName &&
      methods.has(methodName) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isExpression(node.initializer) &&
      expressionIsIdentityArrayInitializer(node.initializer)
    ) {
      arrayInitializerLocals.add(node.name.text);
    }

    if (ts.isCallExpression(node)) {
      const methodName = getCallMethodNameFromExpression(node.expression);
      const receiver = getCallReceiverFromExpression(node.expression);
      const receiverIsCellLike = !checker ||
        (receiver &&
          isCellLikeType(checker.getTypeAtLocation(receiver), checker));
      if (methodName === "set" && receiverIsCellLike) {
        for (const argument of node.arguments) {
          const current = unwrapExpression(argument);
          if (ts.isIdentifier(current)) {
            setArgumentLocals.add(current.text);
          }
        }
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const current = unwrapExpression(node.expression);
      const isSetCallReceiver = node.name.text === "set" &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node;
      const isIdentityWriterReceiver = isCallReceiverForMethod(
        node,
        ARRAY_IDENTITY_WRITER_METHODS,
      );
      if (
        ts.isIdentifier(current) && !isSetCallReceiver &&
        !isIdentityWriterReceiver
      ) {
        structurallyAccessedArrayLocals.add(current.text);
      }
    }

    if (ts.isElementAccessExpression(node)) {
      const current = unwrapExpression(node.expression);
      const isSetCallReceiver = node.argumentExpression &&
        isLiteralElement(node.argumentExpression) &&
        getLiteralElementText(node.argumentExpression) === "set" &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node;
      const isIdentityWriterReceiver = isCallReceiverForMethod(
        node,
        ARRAY_IDENTITY_WRITER_METHODS,
      );
      if (
        ts.isIdentifier(current) && !isSetCallReceiver &&
        !isIdentityWriterReceiver
      ) {
        structurallyAccessedArrayLocals.add(current.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return new Set(
    [...arrayInitializerLocals].filter((name) =>
      setArgumentLocals.has(name) && !structurallyAccessedArrayLocals.has(name)
    ),
  );
}

function getCallReceiverFromExpression(
  expression: ts.Expression,
): ts.Expression | undefined {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return current.expression;
  }
  if (ts.isElementAccessExpression(current)) {
    return current.expression;
  }
  return undefined;
}

function getCallMethodNameFromExpression(
  expression: ts.Expression,
): string | undefined {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text;
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    isLiteralElement(current.argumentExpression)
  ) {
    return getLiteralElementText(current.argumentExpression);
  }
  return undefined;
}

function isKnownIdentityEqualsCallee(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): boolean {
  const current = unwrapExpression(expr);

  if (ts.isIdentifier(current)) {
    if (current.text !== "equals" && current.text !== "equalLinks") {
      return false;
    }
    if (!checker) {
      return true;
    }
    const symbol = checker.getSymbolAtLocation(current);
    return resolvesToCommonFabricSymbol(symbol, checker, current.text);
  }

  if (ts.isPropertyAccessExpression(current)) {
    if (current.name.text !== "equals" && current.name.text !== "equalLinks") {
      return false;
    }
    return !checker ||
      isCellLikeType(checker.getTypeAtLocation(current.expression), checker);
  }

  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    isLiteralElement(current.argumentExpression)
  ) {
    const methodName = getLiteralElementText(current.argumentExpression);
    if (methodName !== "equals" && methodName !== "equalLinks") {
      return false;
    }
    return !checker ||
      isCellLikeType(checker.getTypeAtLocation(current.expression), checker);
  }

  return false;
}

function isKnownIdentityEqualsCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): boolean {
  return isKnownIdentityEqualsCallee(call.expression, checker);
}

function isKnownIdentityNavigationCallee(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): boolean {
  const current = unwrapExpression(expr);
  if (!ts.isIdentifier(current) || current.text !== "navigateTo") {
    return false;
  }
  if (!checker) {
    return true;
  }
  const symbol = checker.getSymbolAtLocation(current);
  return resolvesToCommonFabricSymbol(symbol, checker, "navigateTo");
}

function isKnownIdentityArgumentCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): boolean {
  return isKnownIdentityEqualsCall(call, checker) ||
    isKnownIdentityNavigationCallee(call.expression, checker);
}

function isAliasShape(binding: AliasBinding): binding is AliasShape {
  return "properties" in binding;
}

function isSourceRefBinding(binding: AliasBinding): binding is SourceRef {
  return "root" in binding;
}

function aliasBindingEquals(
  left: AliasBinding,
  right: AliasBinding,
): boolean {
  if (isSourceRefBinding(left) && isSourceRefBinding(right)) {
    return left.root === right.root &&
      left.dynamic === right.dynamic &&
      !!left.arrayElement === !!right.arrayElement &&
      !!left.elementResult === !!right.elementResult &&
      left.path.length === right.path.length &&
      left.path.every((segment, index) => segment === right.path[index]);
  }

  if (isAliasShape(left) && isAliasShape(right)) {
    if (left.properties.size !== right.properties.size) {
      return false;
    }
    for (const [key, leftValue] of left.properties.entries()) {
      const rightValue = right.properties.get(key);
      if (!rightValue || !aliasBindingEquals(leftValue, rightValue)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function clearBindingAliases(
  name: ts.BindingName,
  aliases: Map<string, SourceRef>,
  aliasShapes: Map<string, AliasShape>,
): void {
  if (ts.isIdentifier(name)) {
    aliases.delete(name.text);
    aliasShapes.delete(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    clearBindingAliases(element.name, aliases, aliasShapes);
  }
}

function assignParameterBindingAlias(
  name: ts.BindingName,
  source: AliasBinding | undefined,
  aliases: Map<string, SourceRef>,
  aliasShapes: Map<string, AliasShape>,
  markWildcard: (name: string) => void,
  checker?: ts.TypeChecker,
): void {
  if (ts.isIdentifier(name)) {
    if (!source) {
      aliases.delete(name.text);
      aliasShapes.delete(name.text);
    } else if (isSourceRefBinding(source)) {
      aliases.set(name.text, source);
      aliasShapes.delete(name.text);
    } else {
      aliases.delete(name.text);
      aliasShapes.set(name.text, source);
    }
    return;
  }

  if (!source) {
    clearBindingAliases(name, aliases, aliasShapes);
    return;
  }

  if (ts.isArrayBindingPattern(name)) {
    if (isSourceRefBinding(source)) {
      markWildcard(source.root);
    }
    clearBindingAliases(name, aliases, aliasShapes);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;

    if (element.dotDotDotToken || element.initializer) {
      if (isSourceRefBinding(source)) {
        markWildcard(source.root);
      }
      clearBindingAliases(element.name, aliases, aliasShapes);
      continue;
    }

    let key: string | undefined;
    if (!element.propertyName) {
      if (ts.isIdentifier(element.name)) {
        key = element.name.text;
      }
    } else {
      key = getStaticPropertyKeyText(element.propertyName, checker);
      if (!key && isSourceRefBinding(source)) {
        markWildcard(source.root);
      }
    }

    if (!key) {
      clearBindingAliases(element.name, aliases, aliasShapes);
      continue;
    }

    assignParameterBindingAlias(
      element.name,
      isSourceRefBinding(source)
        ? extendSourceRef(source, [key])
        : source.properties.get(key),
      aliases,
      aliasShapes,
      markWildcard,
      checker,
    );
  }
}

function toCapability(state: MutableCapabilityState): ReactiveCapability {
  const hasReads = state.reads.size > 0;
  const hasWrites = state.writes.size > 0;

  if (hasReads && hasWrites) return "writable";
  if (hasReads) return "readonly";
  if (hasWrites) return "writeonly";
  if (state.rawComparablePaths.size > 0 && !state.hasNonIdentityUse) {
    return "comparable";
  }
  return "opaque";
}

function normalizeObservedCapabilityUsage(
  state: MutableCapabilityState,
): ObservedCapabilityUsage {
  const readPaths = Array.from(state.reads).map(decodePath);
  const fullShapePaths = Array.from(state.fullShapeReads).map(decodePath);
  const writePaths = Array.from(state.writes).map(decodePath);
  const opaquePaths = Array.from(state.rawOpaquePaths)
    .map(decodePath)
    .filter((opaquePath) =>
      ![
        ...readPaths,
        ...fullShapePaths,
        ...writePaths,
      ].some((path) =>
        path.length >= opaquePath.length &&
        opaquePath.every((segment, index) => path[index] === segment)
      )
    );
  const identityPaths = Array.from(state.rawIdentityPaths)
    .map(decodePath)
    .filter((identityPath) => {
      if (state.wildcard) {
        return false;
      }
      if (identityPath.length === 0 && state.hasNonIdentityRootUse) {
        return false;
      }
      const overlapsNonIdentity = [
        ...readPaths,
        ...fullShapePaths,
        ...writePaths,
        ...opaquePaths,
      ].some((path) =>
        path.length >= identityPath.length &&
        identityPath.every((segment, index) => path[index] === segment)
      );
      return !overlapsNonIdentity;
    });
  const keptIdentityPaths = new Set(identityPaths.map(encodePath));
  const identityCellPaths = Array.from(state.rawIdentityCellPaths)
    .filter((path) => keptIdentityPaths.has(path))
    .map(decodePath);
  const comparablePaths = Array.from(state.rawComparablePaths)
    .filter((path) => keptIdentityPaths.has(path))
    .map(decodePath);
  const keptComparablePaths = new Set(comparablePaths.map(encodePath));
  const comparableCellPaths = Array.from(state.rawComparableCellPaths)
    .filter((path) => keptComparablePaths.has(path))
    .map(decodePath);

  return {
    readPaths,
    fullShapePaths,
    writePaths,
    opaquePaths,
    passthrough: state.passthrough,
    wildcard: state.wildcard,
    hasUnverifiedCellUse: state.hasUnverifiedCellUse,
    identityOnly: identityPaths.some((path) => path.length === 0) &&
      !state.hasNonIdentityUse &&
      state.reads.size === 0 &&
      state.writes.size === 0 &&
      !state.wildcard,
    identityPaths,
    identityCellPaths,
    comparablePaths,
    comparableCellPaths,
  };
}

function buildCapabilityParamSummary(
  name: string,
  state: MutableCapabilityState,
): CapabilityParamSummary {
  const observed = normalizeObservedCapabilityUsage(state);
  return {
    name,
    capability: toCapability(state),
    ...observed,
  };
}

export function analyzeFunctionCapabilities(
  fn: CapabilityAnalyzableFunction,
  options?: CapabilityAnalysisOptions,
): FunctionCapabilitySummary {
  const summaryCache = options?.summaryCache ?? new WeakMap();
  const inProgress = options?.inProgress ?? new WeakSet();
  const cached = summaryCache.get(fn);
  if (cached) {
    return cached;
  }
  if (inProgress.has(fn)) {
    // Recursion detected — return an empty summary so callers skip shrinking
    // for this function. The `recursive` flag lets callers emit a diagnostic
    // if they choose to.
    return { params: [], recursive: true };
  }
  inProgress.add(fn);
  try {
    const checker = options?.checker;
    const typeRegistry = options?.typeRegistry;
    const interprocedural = !!options?.interprocedural && !!checker;
    const includeNestedCallbacks = !!options?.includeNestedCallbacks;
    const summarySourceFile = fn.getSourceFile();

    // Mergeable `push` call sites, explicit read sites (`.get()` and `for..of`
    // iterables), and non-append same-collection write paths, collected only
    // when a misuse sink is given. After the walk, a push site whose receiver
    // path the function also reads is classified by how that read relates to
    // the push and reported through the sink.
    const mergeablePushMisuseSink = options?.mergeablePushMisuseSink;
    const mergeablePushSites: MergeableCollectionSite[] = [];
    const mergeableReadSites: MergeableCollectionSite[] = [];
    const mergeableNonAppendWriteKeys = new Set<string>();
    const mergeableWriteKey = (root: string, encodedPath: string): string =>
      JSON.stringify([root, encodedPath]);
    const recordMergeableReadSite = (ref: SourceRef, node: ts.Node): void => {
      if (!mergeablePushMisuseSink || ref.dynamic) return;
      mergeableReadSites.push({
        root: ref.root,
        encodedPath: encodePath(ref.path),
        node,
      });
    };
    const recordMergeableNonAppendWrite = (ref: SourceRef): void => {
      if (!mergeablePushMisuseSink || ref.dynamic) return;
      mergeableNonAppendWriteKeys.add(
        mergeableWriteKey(ref.root, encodePath(ref.path)),
      );
    };

    if (!fn.body) {
      const empty = { params: [] };
      summaryCache.set(fn, empty);
      return empty;
    }

    const states = new Map<string, MutableCapabilityState>();
    const aliases = new Map<string, SourceRef>();
    const aliasShapes = new Map<string, AliasShape>();
    const optionalPresenceAliases = new Set<string>();
    const localArrayElementBindings = new Map<string, AliasBinding>();
    const localMapValueBindings = new Map<string, AliasBinding>();
    const parameterStateKeys: string[] = [];

    const ensureState = (name: string): MutableCapabilityState => {
      let state = states.get(name);
      if (!state) {
        state = {
          reads: new Set<string>(),
          fullShapeReads: new Set<string>(),
          writes: new Set<string>(),
          rawIdentityPaths: new Set<string>(),
          rawIdentityCellPaths: new Set<string>(),
          rawComparablePaths: new Set<string>(),
          rawComparableCellPaths: new Set<string>(),
          rawOpaquePaths: new Set<string>(),
          passthrough: false,
          wildcard: false,
          hasIdentityUse: false,
          hasNonIdentityUse: false,
          hasNonIdentityRootUse: false,
          hasUnverifiedCellUse: false,
        };
        states.set(name, state);
      }
      return state;
    };

    const trackRead = (
      name: string,
      path: readonly string[],
      options?: { identityOnly?: boolean },
    ): void => {
      const state = ensureState(name);
      state.reads.add(encodePath(path));
      if (options?.identityOnly) {
        state.hasIdentityUse = true;
      } else {
        state.hasNonIdentityUse = true;
      }
    };

    const trackWrite = (name: string, path: readonly string[]): void => {
      const state = ensureState(name);
      state.writes.add(encodePath(path));
      state.hasNonIdentityUse = true;
    };

    const trackFullShapeRead = (
      name: string,
      path: readonly string[],
    ): void => {
      const state = ensureState(name);
      state.fullShapeReads.add(encodePath(path));
      state.hasNonIdentityUse = true;
    };

    const markWildcard = (name: string): void => {
      const state = ensureState(name);
      state.wildcard = true;
      state.hasNonIdentityUse = true;
    };

    // Unlike markWildcard this does NOT change shrinking or identity
    // classification — it only poisons write-exhaustiveness for consumers
    // that need `writes` to be a closed-world record, while everything else
    // behaves as before.
    const markUnverifiedCellUse = (name: string): void => {
      const state = ensureState(name);
      state.hasUnverifiedCellUse = true;
    };

    const markPassthrough = (
      name: string,
      options?: { identityOnly?: boolean },
    ): void => {
      const state = ensureState(name);
      state.passthrough = true;
      if (options?.identityOnly) {
        state.hasIdentityUse = true;
      } else {
        state.hasNonIdentityUse = true;
        state.hasNonIdentityRootUse = true;
      }
    };

    const markOpaqueUse = (name: string, path: readonly string[]): void => {
      const state = ensureState(name);
      state.hasNonIdentityUse = true;
      if (path.length === 0) {
        state.hasNonIdentityRootUse = true;
      }
    };

    const recordOpaquePath = (
      name: string,
      path: readonly string[],
    ): void => {
      const state = ensureState(name);
      state.rawOpaquePaths.add(encodePath(path));
      state.hasNonIdentityUse = true;
      if (path.length === 0) {
        state.hasNonIdentityRootUse = true;
      }
    };

    const recordIdentityPath = (
      name: string,
      path: readonly string[],
      options?: { cellLike?: boolean },
    ): void => {
      const state = ensureState(name);
      const encoded = encodePath(path);
      state.rawIdentityPaths.add(encoded);
      if (options?.cellLike) {
        state.rawIdentityCellPaths.add(encoded);
      }
      state.hasIdentityUse = true;
    };

    const recordComparablePath = (
      name: string,
      path: readonly string[],
      options?: { cellLike?: boolean },
    ): void => {
      recordIdentityPath(name, path, options);
      const state = ensureState(name);
      const encoded = encodePath(path);
      state.rawComparablePaths.add(encoded);
      if (options?.cellLike) {
        state.rawComparableCellPaths.add(encoded);
      }
    };

    const hasRecordedIdentityPath = (
      name: string,
      path: readonly string[],
    ): boolean => {
      return ensureState(name).rawIdentityPaths.has(encodePath(path));
    };

    const hasRecordedIdentityUseRef = (ref: SourceRef): boolean => {
      const materialized = materializeSourceRef(ref);
      if (materialized.dynamic) {
        return false;
      }
      return hasRecordedIdentityPath(materialized.root, materialized.path);
    };

    const isCellLikeExpression = (expr: ts.Expression): boolean => {
      if (!checker) {
        return false;
      }
      return isCellLikeType(checker.getTypeAtLocation(expr), checker);
    };

    const isPrimitiveLikeExpression = (expr: ts.Expression): boolean => {
      // Prefer the transformer-known type: on synthetic callbacks (e.g. the
      // destructure-lowered lift-applied param) the checker resolves bindings
      // to `any`, whose flags match none of the primitive families below — so
      // relying on the checker alone would mis-classify a real primitive as
      // non-primitive and let the presence-only skip drop it from the schema.
      const type = typeRegistry?.get(expr) ??
        (checker ? checker.getTypeAtLocation(expr) : undefined);
      if (!type) {
        return false;
      }
      const flags = type.flags;
      return !!(
        flags &
        (ts.TypeFlags.BooleanLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.StringLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.ESSymbolLike |
          ts.TypeFlags.EnumLike)
      );
    };

    for (let index = 0; index < fn.parameters.length; index++) {
      const parameter = fn.parameters[index]!;
      const stateKey = ts.isIdentifier(parameter.name)
        ? parameter.name.text
        : `${PARAMETER_SUMMARY_PREFIX}${index}`;
      parameterStateKeys[index] = stateKey;
      ensureState(stateKey);

      if (ts.isIdentifier(parameter.name)) {
        aliases.set(parameter.name.text, {
          root: stateKey,
          path: [],
          dynamic: false,
        });
        continue;
      }

      assignParameterBindingAlias(
        parameter.name,
        {
          root: stateKey,
          path: [],
          dynamic: false,
        },
        aliases,
        aliasShapes,
        markWildcard,
        checker,
      );
    }

    if (parameterStateKeys.length === 0) {
      const empty = { params: [] };
      summaryCache.set(fn, empty);
      return empty;
    }

    // Track .get() CallExpression nodes whose result was resolved with a more
    // specific path (e.g. notes.get().length → ["length"]).  When the
    // READER_METHODS handler encounters these, it skips the blanket [] read.
    const resolvedGetCalls = new Set<ts.Node>();

    // Track alias names (e.g. "notes") that were resolved with specific
    // property paths through a .get() chain.  When the identifier handler
    // encounters a synthetic identifier with no parent pointer, it can skip
    // the blanket read if the alias already has a more specific path.
    const aliasesWithSpecificPaths = new Set<string>();
    const identityArrayLocals = collectArrayLocalsPassedToSet(fn.body, checker);
    const signatureCapabilityArgumentUses = new WeakSet<ts.Expression>();
    const unreadableCellArguments: UnreadableCellArgument[] = [];

    const getIdentifierName = (
      expression: ts.Expression,
    ): string | undefined => {
      const current = unwrapExpression(expression);
      return ts.isIdentifier(current) ? current.text : undefined;
    };

    const getCallMethodName = (
      expression: ts.Expression,
    ): string | undefined => {
      const current = unwrapExpression(expression);
      if (ts.isPropertyAccessExpression(current)) {
        return current.name.text;
      }
      if (
        ts.isElementAccessExpression(current) &&
        current.argumentExpression &&
        isLiteralElement(current.argumentExpression)
      ) {
        return getLiteralElementText(current.argumentExpression);
      }
      return undefined;
    };

    const resolveShapePath = (
      binding: AliasBinding | undefined,
      path: readonly string[],
    ): AliasBinding | undefined => {
      if (!binding) return undefined;
      if (path.length === 0) {
        return binding;
      }
      if (isSourceRefBinding(binding)) {
        return extendSourceRef(binding, path);
      }

      const [head, ...tail] = path;
      const child = binding.properties.get(head!);
      return resolveShapePath(child, tail);
    };

    const resolveBinding = (
      expression: ts.Expression,
    ): AliasBinding | undefined => {
      const current = unwrapExpression(expression);
      if (
        ts.isBinaryExpression(current) &&
        FALLBACK_OPERATORS.has(current.operatorToken.kind)
      ) {
        const left = resolveBinding(current.left);
        const right = resolveBinding(current.right);
        if (left && right) {
          return aliasBindingEquals(left, right) ? left : undefined;
        }
        return left ?? right;
      }

      const info = extractAccessPath(current, checker);
      if (info) {
        const alias = aliases.get(info.root);
        if (alias) {
          const resolved = extendSourceRef(alias, info.path);
          return {
            root: resolved.root,
            path: resolved.path,
            dynamic: resolved.dynamic || info.dynamic,
            elementResult: resolved.elementResult,
          };
        }

        if (!info.dynamic) {
          const shape = aliasShapes.get(info.root);
          const resolved = resolveShapePath(shape, info.path);
          if (resolved) {
            return resolved;
          }
        }
      }

      if (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
      ) {
        const innerBinding = resolveBinding(current.expression) ??
          (ts.isCallExpression(current.expression)
            ? buildAliasBindingFromExpression(current.expression)
            : undefined);
        if (innerBinding) {
          if (ts.isPropertyAccessExpression(current)) {
            if (ts.isCallExpression(current.expression)) {
              resolvedGetCalls.add(current.expression);
            }
            return resolveShapePath(innerBinding, [current.name.text]);
          }
          if (
            ts.isElementAccessExpression(current) &&
            isLiteralElement(current.argumentExpression)
          ) {
            if (ts.isCallExpression(current.expression)) {
              resolvedGetCalls.add(current.expression);
            }
            return resolveShapePath(innerBinding, [
              getLiteralElementText(current.argumentExpression),
            ]);
          }
        }
      }

      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression)
      ) {
        const methodName = current.expression.name.text;
        const localMapName = getIdentifierName(current.expression.expression);
        if (methodName === "get" && localMapName) {
          const localBinding = localMapValueBindings.get(localMapName);
          if (localBinding) {
            return localBinding;
          }
        }

        const receiverBinding = resolveBinding(current.expression.expression);
        if (receiverBinding && isSourceRefBinding(receiverBinding)) {
          if (methodName === "get" && current.arguments.length === 0) {
            return receiverBinding;
          }
          if (methodName === "key") {
            const argPath = extractLiteralPathArguments(
              current.arguments,
              checker,
            );
            if (argPath.dynamic) {
              return {
                ...receiverBinding,
                dynamic: true,
              };
            }
            return {
              root: receiverBinding.root,
              path: [...receiverBinding.path, ...argPath.path],
              dynamic: receiverBinding.dynamic,
            };
          }
          // elementById addresses a separate, deterministically derived entity,
          // not a static path into the array. Resolve it to a dynamic binding on
          // the array root so reads and writes through it are attributed
          // conservatively to the array the handler already touches.
          if (methodName === "elementById") {
            return {
              ...receiverBinding,
              dynamic: true,
            };
          }
        }
      }

      return undefined;
    };

    const resolveSourceRef = (
      expression: ts.Expression,
    ): SourceRef | undefined => {
      const binding = resolveBinding(expression);
      return binding && isSourceRefBinding(binding) ? binding : undefined;
    };

    const resolveConservativeCallReceiverRef = (
      call: ts.CallExpression,
    ): SourceRef | undefined => {
      const target = unwrapExpression(call.expression);
      if (
        !ts.isPropertyAccessExpression(target) &&
        !ts.isElementAccessExpression(target)
      ) {
        return undefined;
      }

      const direct = resolveSourceRef(target.expression);
      if (direct) {
        return direct;
      }

      return ts.isCallExpression(target.expression)
        ? resolveConservativeCallReceiverRef(target.expression)
        : undefined;
    };

    const buildAliasBindingFromExpression = (
      expression: ts.Expression,
    ): AliasBinding | undefined => {
      const direct = resolveBinding(expression);
      if (direct) {
        return direct;
      }

      const current = unwrapExpression(expression);
      if (
        ts.isCallExpression(current) &&
        (
          ts.isPropertyAccessExpression(current.expression) ||
          ts.isElementAccessExpression(current.expression)
        )
      ) {
        const receiverExpr = current.expression.expression;
        const methodName = getCallMethodName(current.expression);
        if (
          receiverExpr &&
          (methodName === "filter" || methodName === "sort" ||
            methodName === "toSorted")
        ) {
          return resolveBinding(receiverExpr);
        }

        if (
          receiverExpr &&
          (methodName === "find" || methodName === "findLast" ||
            methodName === "at")
        ) {
          const binding = resolveArrayElementBinding(receiverExpr);
          if (binding && isSourceRefBinding(binding)) {
            return {
              root: binding.root,
              path: binding.path,
              dynamic: binding.dynamic,
              arrayElement: true,
              elementResult: true,
            };
          }
        }
      }

      if (!ts.isObjectLiteralExpression(current)) {
        return undefined;
      }

      const properties = new Map<string, AliasBinding>();
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          return undefined;
        }

        if (ts.isShorthandPropertyAssignment(property)) {
          const binding = resolveBinding(property.name);
          if (binding) {
            properties.set(property.name.text, binding);
          }
          continue;
        }

        if (!ts.isPropertyAssignment(property)) {
          continue;
        }

        const key = getStaticPropertyKeyText(property.name, checker);
        if (!key) {
          return undefined;
        }

        const binding = buildAliasBindingFromExpression(property.initializer);
        if (binding) {
          properties.set(key, binding);
        }
      }

      return properties.size > 0 ? { properties } : undefined;
    };

    const mergeAliasBinding = (
      current: AliasBinding | undefined,
      next: AliasBinding | undefined,
    ): AliasBinding | undefined => {
      if (!next) return current;
      if (!current) return next;
      return aliasBindingEquals(current, next) ? current : undefined;
    };

    const updateLocalCollectionBinding = (
      bindings: Map<string, AliasBinding>,
      name: string,
      next: AliasBinding | undefined,
    ): void => {
      if (!next) {
        bindings.delete(name);
        return;
      }

      const merged = mergeAliasBinding(bindings.get(name), next);
      if (merged) {
        bindings.set(name, merged);
      } else {
        bindings.delete(name);
      }
    };

    const resolveArrayElementBinding = (
      expression: ts.Expression,
    ): AliasBinding | undefined => {
      const current = unwrapExpression(expression);
      if (ts.isCallExpression(current)) {
        const target = unwrapExpression(current.expression);
        const receiverExpr = ts.isPropertyAccessExpression(target) ||
            ts.isElementAccessExpression(target)
          ? target.expression
          : undefined;
        const methodName = getCallMethodName(current.expression);
        if (
          receiverExpr &&
          (methodName === "filter" || methodName === "sort" ||
            methodName === "toSorted")
        ) {
          return resolveArrayElementBinding(receiverExpr);
        }
      }

      const localName = getIdentifierName(expression);
      if (localName) {
        const localBinding = localArrayElementBindings.get(localName);
        if (localBinding) {
          return localBinding;
        }
      }

      const source = resolveSourceRef(expression);
      if (!source) {
        return undefined;
      }
      return {
        root: source.root,
        path: source.path,
        dynamic: source.dynamic,
        arrayElement: true,
      };
    };

    const clearLocalCollectionBindings = (name: string): void => {
      localArrayElementBindings.delete(name);
      localMapValueBindings.delete(name);
    };

    const scopedLocalCollectionNamesStack: Array<Set<string>> = [];

    const markScopedLocalCollectionName = (name: string): void => {
      const currentScope = scopedLocalCollectionNamesStack[
        scopedLocalCollectionNamesStack.length - 1
      ];
      currentScope?.add(name);
    };

    const clearScopedLocalCollectionBindingNames = (
      name: ts.BindingName,
    ): void => {
      if (ts.isIdentifier(name)) {
        markScopedLocalCollectionName(name.text);
        clearLocalCollectionBindings(name.text);
        return;
      }

      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        clearScopedLocalCollectionBindingNames(element.name);
      }
    };

    const restoreScopedLocalCollectionBindings = (
      names: ReadonlySet<string>,
      savedArrayElementBindings: ReadonlyMap<string, AliasBinding>,
      savedMapValueBindings: ReadonlyMap<string, AliasBinding>,
    ): void => {
      for (const name of names) {
        const arrayBinding = savedArrayElementBindings.get(name);
        if (arrayBinding) {
          localArrayElementBindings.set(name, arrayBinding);
        } else {
          localArrayElementBindings.delete(name);
        }

        const mapBinding = savedMapValueBindings.get(name);
        if (mapBinding) {
          localMapValueBindings.set(name, mapBinding);
        } else {
          localMapValueBindings.delete(name);
        }
      }
    };

    const visitScopedLocalCollectionBindings = (visitor: () => void): void => {
      const savedLocalArrayElementBindings = new Map(
        localArrayElementBindings,
      );
      const savedLocalMapValueBindings = new Map(localMapValueBindings);
      const scopedLocalCollectionNames = new Set<string>();
      scopedLocalCollectionNamesStack.push(scopedLocalCollectionNames);

      try {
        visitor();
      } finally {
        scopedLocalCollectionNamesStack.pop();
        restoreScopedLocalCollectionBindings(
          scopedLocalCollectionNames,
          savedLocalArrayElementBindings,
          savedLocalMapValueBindings,
        );
      }
    };

    const recordLocalArrayIdentityWrite = (
      arrayName: string,
      args: readonly ts.Expression[],
    ): void => {
      let next = localArrayElementBindings.get(arrayName);
      for (const arg of args) {
        next = mergeAliasBinding(next, buildAliasBindingFromExpression(arg));
        if (!next) {
          break;
        }
      }
      if (next) {
        localArrayElementBindings.set(arrayName, next);
      } else {
        localArrayElementBindings.delete(arrayName);
      }
    };

    const recordLocalMapSet = (
      mapName: string,
      valueExpr: ts.Expression | undefined,
    ): void => {
      updateLocalCollectionBinding(
        localMapValueBindings,
        mapName,
        valueExpr ? buildAliasBindingFromExpression(valueExpr) : undefined,
      );
    };

    const trackReadRef = (
      ref: SourceRef,
      options?: { identityOnly?: boolean },
    ): void => {
      if (ref.dynamic) {
        markWildcard(ref.root);
        return;
      }
      trackRead(ref.root, ref.path, options);
    };

    const trackWriteRef = (ref: SourceRef): void => {
      if (ref.dynamic) {
        markWildcard(ref.root);
        return;
      }
      trackWrite(ref.root, ref.path);
    };

    const trackFullShapeReadRef = (ref: SourceRef): void => {
      if (ref.dynamic) {
        markWildcard(ref.root);
        return;
      }
      trackFullShapeRead(ref.root, ref.path);
    };

    const assignBindingAlias = (
      name: ts.BindingName,
      source: AliasBinding | undefined,
    ): void => {
      assignParameterBindingAlias(
        name,
        source,
        aliases,
        aliasShapes,
        markWildcard,
        checker,
      );
    };

    const assignExpressionPatternAlias = (
      pattern: ts.Expression,
      source: AliasBinding | undefined,
    ): void => {
      if (ts.isParenthesizedExpression(pattern)) {
        assignExpressionPatternAlias(pattern.expression, source);
        return;
      }

      if (ts.isIdentifier(pattern)) {
        assignBindingAlias(pattern, source);
        return;
      }

      if (ts.isObjectLiteralExpression(pattern)) {
        if (!source) {
          for (const property of pattern.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
              aliases.delete(property.name.text);
              aliasShapes.delete(property.name.text);
            } else if (ts.isPropertyAssignment(property)) {
              assignExpressionPatternAlias(property.initializer, undefined);
            }
          }
          return;
        }

        for (const property of pattern.properties) {
          if (ts.isSpreadAssignment(property)) {
            if (isSourceRefBinding(source)) {
              markWildcard(source.root);
            }
            continue;
          }

          if (ts.isShorthandPropertyAssignment(property)) {
            const binding = isSourceRefBinding(source)
              ? extendSourceRef(source, [property.name.text])
              : source.properties.get(property.name.text);
            if (binding && isSourceRefBinding(binding)) {
              trackRead(binding.root, binding.path);
            }
            assignBindingAlias(property.name, binding);
            continue;
          }

          if (!ts.isPropertyAssignment(property)) {
            continue;
          }

          const key = getStaticPropertyKeyText(property.name, checker);
          if (!key && isSourceRefBinding(source)) {
            markWildcard(source.root);
          }

          if (!key) {
            assignExpressionPatternAlias(property.initializer, undefined);
            continue;
          }

          const binding = isSourceRefBinding(source)
            ? extendSourceRef(source, [key])
            : source.properties.get(key);
          if (binding && isSourceRefBinding(binding)) {
            trackRead(binding.root, binding.path);
          }
          assignExpressionPatternAlias(property.initializer, binding);
        }
        return;
      }

      if (ts.isArrayLiteralExpression(pattern)) {
        if (source && isSourceRefBinding(source)) {
          markWildcard(source.root);
        }
        for (const element of pattern.elements) {
          if (ts.isSpreadElement(element)) {
            continue;
          }
          assignExpressionPatternAlias(element, undefined);
        }
      }
    };

    const markWildcardFromExpression = (expression: ts.Expression): void => {
      const ref = resolveSourceRef(expression);
      if (!ref) return;
      markWildcard(ref.root);
    };

    const markFromExpression = (
      expression: ts.Expression,
      marker: (name: string, path: readonly string[]) => void,
    ): void => {
      const ref = resolveSourceRef(expression);
      if (!ref) return;
      if (ref.dynamic) {
        markWildcard(ref.root);
        return;
      }
      marker(ref.root, ref.path);
    };

    const markIdentityUseRef = (
      ref: SourceRef,
      expr?: ts.Expression,
      options?: { comparable?: boolean },
    ): void => {
      const cellLike = expr
        ? isCellLikeExpression(expr) || !isPrimitiveLikeExpression(expr)
        : false;
      const record = options?.comparable
        ? recordComparablePath
        : recordIdentityPath;
      if (ref.dynamic) {
        markWildcard(ref.root);
      } else if (ref.path.length === 0) {
        record(ref.root, [], { cellLike });
        markPassthrough(ref.root, { identityOnly: true });
      } else {
        record(ref.root, ref.path, { cellLike });
      }
    };

    const markArrayItemIdentityUseRef = (ref: SourceRef): void => {
      const materialized = materializeSourceRef(ref);
      if (materialized.dynamic) {
        markWildcard(materialized.root);
        return;
      }
      recordIdentityPath(materialized.root, [...materialized.path, "0"]);
    };

    const resolveInterproceduralSummary = (
      call: ts.CallExpression,
    ): FunctionCapabilitySummary | undefined => {
      if (!interprocedural || !checker) return undefined;
      const signature = checker.getResolvedSignature(call);
      if (!signature) return undefined;
      const declaration = signature.declaration;
      if (!isInterproceduralSummaryTarget(declaration, summarySourceFile)) {
        return undefined;
      }

      return analyzeFunctionCapabilities(declaration, {
        checker,
        typeRegistry,
        interprocedural: true,
        summaryCache,
        inProgress,
      });
    };

    // Apply the capability an out-of-file callee declares for a cell argument
    // through its Common Fabric wrapper parameter type. Body analysis cannot see
    // what the callee does with the cell, so the declared wrapper type is the
    // contract: it accounts for that argument at that call and replaces the
    // conservative default. Returns the handled argument indices so the
    // whole-cell root fallback skips them; the argument's usage site is recorded
    // so ordinary identifier handling does not add a second, broader read.
    const applySignatureCellCapabilities = (
      call: ts.CallExpression | ts.NewExpression,
    ): Set<number> => {
      const handled = new Set<number>();
      if (!checker) return handled;

      const signature = checker.getResolvedSignature(call);
      if (!signature) return handled;
      if (!isSignatureDeclaredOutsideSourceFile(signature, summarySourceFile)) {
        return handled;
      }

      const args = call.arguments;
      if (!args) return handled;

      for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (!argument) continue;

        const parameter = getParameterAtArgument(signature, index);
        const isSpreadArgument = ts.isSpreadElement(argument);
        // An array spread has unknown runtime length, so it cannot be matched to
        // later fixed parameters; stop signature mapping there. A spread into a
        // rest parameter is a collection of rest elements, recorded below at the
        // representative array-item path.
        if (isSpreadArgument && !isRestParameter(parameter)) break;

        const capabilityArgument = isSpreadArgument
          ? argument.expression
          : argument;
        const source = resolveSourceRef(capabilityArgument);
        if (!source) continue;

        const cellKind = getParameterDeclaredCellKind(parameter, checker);
        if (!cellKind) {
          // The parameter type is not a recognized wrapper. Flag only the
          // genuinely ambiguous shape: a union that mixes a cell wrapper with an
          // unresolvable member (the overload-split case), and only when an
          // actual cell argument flows there. Value-or-cell framework types and
          // bare `Cell<T>`/generics/`any` are intentionally not flagged.
          const effectiveTypeNode = getEffectiveParameterTypeNode(parameter);
          if (
            isAmbiguousCellWrapperUnion(effectiveTypeNode, checker) &&
            isBrandedCellType(
              checker.getTypeAtLocation(capabilityArgument),
              checker,
            )
          ) {
            unreadableCellArguments.push({
              node: capabilityArgument,
              message: buildUnreadableCellArgumentMessage(effectiveTypeNode),
            });
          }
          continue;
        }

        handled.add(index);
        signatureCapabilityArgumentUses.add(
          unwrapExpressionUsageSite(capabilityArgument),
        );

        if (source.dynamic) {
          markWildcard(source.root);
          continue;
        }

        const sourcePath = isSpreadArgument
          ? [...source.path, "0"]
          : source.path;

        switch (cellKind) {
          case "cell":
            trackRead(source.root, sourcePath);
            trackWrite(source.root, sourcePath);
            break;
          case "readonly":
            trackRead(source.root, sourcePath);
            break;
          case "writeonly":
            trackWrite(source.root, sourcePath);
            break;
          case "comparable":
            recordComparablePath(source.root, sourcePath, {
              cellLike: true,
            });
            break;
          case "opaque":
          case "stream":
          case "sqlite":
            recordOpaquePath(source.root, sourcePath);
            break;
        }
      }

      return handled;
    };

    const visitScopedFunctionBody = (
      callback: CapabilityAnalyzableFunction,
      paramBindings?: ReadonlyMap<number, AliasBinding>,
    ): void => {
      const savedAliases = new Map(aliases);
      const savedAliasShapes = new Map(aliasShapes);
      const savedOptionalPresenceAliases = new Set(optionalPresenceAliases);
      const savedSpecificPaths = new Set(aliasesWithSpecificPaths);
      const savedLocalArrayElementBindings = new Map(
        localArrayElementBindings,
      );
      const savedLocalMapValueBindings = new Map(localMapValueBindings);
      const scopedLocalCollectionNames = new Set<string>();
      scopedLocalCollectionNamesStack.push(scopedLocalCollectionNames);

      try {
        if (callback.name && ts.isIdentifier(callback.name)) {
          aliases.delete(callback.name.text);
          aliasShapes.delete(callback.name.text);
        }
        for (const [index, parameter] of callback.parameters.entries()) {
          clearScopedLocalCollectionBindingNames(parameter.name);
          clearBindingAliases(parameter.name, aliases, aliasShapes);
          const binding = paramBindings?.get(index);
          if (binding) {
            assignBindingAlias(parameter.name, binding);
          }
        }

        const body = callback.body;
        if (!body) return;

        if (ts.isBlock(body)) {
          for (const statement of body.statements) {
            visit(statement);
          }
        } else {
          visit(body);
        }
      } finally {
        scopedLocalCollectionNamesStack.pop();
        aliases.clear();
        for (const [name, source] of savedAliases) {
          aliases.set(name, source);
        }
        aliasShapes.clear();
        for (const [name, shape] of savedAliasShapes) {
          aliasShapes.set(name, shape);
        }
        optionalPresenceAliases.clear();
        for (const name of savedOptionalPresenceAliases) {
          optionalPresenceAliases.add(name);
        }
        aliasesWithSpecificPaths.clear();
        for (const name of savedSpecificPaths) {
          aliasesWithSpecificPaths.add(name);
        }
        restoreScopedLocalCollectionBindings(
          scopedLocalCollectionNames,
          savedLocalArrayElementBindings,
          savedLocalMapValueBindings,
        );
      }
    };

    const visitInlineEagerCallbackArguments = (
      call: ts.CallExpression,
    ): void => {
      if (!checker) return;

      const callbackContainerKind = classifyArrayCallbackContainerCall(
        call,
        checker,
      );
      if (!callbackContainerKind) {
        return;
      }

      const callbackArg = call.arguments[0];
      if (!callbackArg || !isCapabilityAnalyzableFunction(callbackArg)) {
        return;
      }

      const paramBindings = new Map<number, AliasBinding>();
      const target = unwrapExpression(call.expression);
      const receiverExpr = ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)
        ? target.expression
        : undefined;
      const itemBinding = receiverExpr
        ? resolveArrayElementBinding(receiverExpr)
        : undefined;
      const methodName = getCallMethodName(call.expression);
      if (itemBinding) {
        if (callbackArg.parameters[0]) {
          paramBindings.set(0, itemBinding);
        }
        if (
          callbackArg.parameters[1] &&
          (methodName === "sort" || methodName === "toSorted")
        ) {
          paramBindings.set(1, itemBinding);
        }
      }

      visitScopedFunctionBody(
        callbackArg,
        paramBindings.size > 0 ? paramBindings : undefined,
      );
    };

    const visit = (node: ts.Node): void => {
      if (node !== fn && isCapabilityAnalyzableFunction(node)) {
        if (includeNestedCallbacks) {
          visitScopedFunctionBody(node);
        }
        return;
      }

      if (
        ts.isBinaryExpression(node) &&
        FALLBACK_OPERATORS.has(node.operatorToken.kind)
      ) {
        const leftExpr = unwrapExpression(node.left);
        const shouldVisitNestedFallbackLeft = ts.isBinaryExpression(leftExpr) &&
          FALLBACK_OPERATORS.has(leftExpr.operatorToken.kind);

        if (shouldVisitNestedFallbackLeft) {
          visit(node.left);
        } else {
          const leftRef = resolveSourceRef(node.left);
          if (leftRef) {
            if (leftRef.dynamic) {
              markWildcard(leftRef.root);
            } else if (leftRef.path.length === 0) {
              markPassthrough(leftRef.root);
            } else {
              trackReadRef(leftRef);
            }
          } else {
            visit(node.left);
          }
        }
        visit(node.right);
        return;
      }

      if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
      ) {
        // Process RHS first so alias rebinding happens after reads in the assignment expression.
        visit(node.right);
        if (!ts.isIdentifier(node.left)) {
          visit(node.left);
        }

        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.EqualsToken) {
          if (ts.isIdentifier(node.left)) {
            clearLocalCollectionBindings(node.left.text);
            assignBindingAlias(
              node.left,
              buildAliasBindingFromExpression(node.right),
            );
          } else if (
            ts.isObjectLiteralExpression(node.left) ||
            ts.isArrayLiteralExpression(node.left)
          ) {
            const nextRef = buildAliasBindingFromExpression(node.right);
            assignExpressionPatternAlias(node.left, nextRef);
          } else {
            markFromExpression(node.left, trackWrite);
          }
        } else {
          if (ts.isIdentifier(node.left)) {
            aliases.delete(node.left.text);
            aliasShapes.delete(node.left.text);
            clearLocalCollectionBindings(node.left.text);
          } else {
            markFromExpression(node.left, trackWrite);
            markFromExpression(node.left, trackRead);
          }
        }

        return;
      }

      if (ts.isIdentifier(node)) {
        if (isDeclarationIdentifier(node)) {
          // Ignore declaration sites.
        } else if (isNonValueIdentifierUsage(node)) {
          // Ignore key names and non-value positions.
        } else {
          const source = aliases.get(node.text);
          if (source && !isMemberRootIdentifier(node)) {
            const resolvedSource = materializeSourceRef(source);
            const usage = unwrapIdentifierUsageSite(node);
            const parent = usage.parent;
            if (!parent) {
              // Synthetic identifiers can temporarily be detached from parent links.
              // Preserve narrowed-path reads while avoiding false root-read expansion.
              if (!resolvedSource.dynamic && resolvedSource.path.length === 0) {
                markPassthrough(resolvedSource.root);
              } else if (aliasesWithSpecificPaths.has(node.text)) {
                // This alias was already resolved with specific property paths
                // (e.g. notes.get().length → ["notes", "length"]).  The blanket
                // read from the detached identifier is redundant.
                markPassthrough(resolvedSource.root);
              } else {
                trackReadRef(resolvedSource);
              }
            } else if (
              source.elementResult &&
              isBooleanConditionUsage(usage)
            ) {
              // Truthiness checks on array-element aliases (e.g. find() results)
              // don't require loading the element payload.
            } else if (
              source.path.length > 0 &&
              !source.dynamic &&
              (optionalPresenceAliases.has(node.text) ||
                !isPrimitiveLikeExpression(usage)) &&
              isBooleanConditionUsage(usage)
            ) {
              // Truthiness checks on a non-primitive source property only
              // require presence, not the aliased payload shape. Recording
              // nothing keeps such a (typically nullable, possibly
              // transiently-undefined) reactive value out of the required input
              // set, so an action/lift gated on it still runs when it is absent.
              //
              // Primitives are handled differently: their value *is* their
              // presence and a required primitive is never legitimately
              // `undefined`, so dropping it would be a real bug (lunch-poll
              // `isAdmin`). `isPrimitiveLikeExpression` — now type-registry
              // aware so it sees through synthetic `any` params — routes
              // primitives to the full read above instead of into this skip.
            } else if (
              signatureCapabilityArgumentUses.has(usage)
            ) {
              // Explicit Common Fabric cell parameter types account for this
              // argument.
            } else if (
              !(
                parent &&
                ts.isPropertyAccessExpression(parent) &&
                parent.name === usage
              ) && !(
                parent &&
                ts.isBinaryExpression(parent) &&
                parent.left === usage &&
                isAssignmentOperator(parent.operatorToken.kind)
              ) && !(
                parent &&
                (ts.isPrefixUnaryExpression(parent) ||
                  ts.isPostfixUnaryExpression(parent)) &&
                parent.operand === usage &&
                (
                  parent.operator === ts.SyntaxKind.PlusPlusToken ||
                  parent.operator === ts.SyntaxKind.MinusMinusToken
                )
              )
            ) {
              const identityOnlyArgumentUse = !!(
                parent &&
                ts.isCallExpression(parent) &&
                parent.arguments.includes(usage) &&
                isKnownIdentityArgumentCall(parent, checker)
              );
              const identityArrayLocal =
                getIdentityArrayLocalNameForElementUsage(usage);
              const identityOnlyArrayElementUse = !!identityArrayLocal &&
                identityArrayLocals.has(identityArrayLocal);
              const identityArrayWriterLocal =
                getIdentityArrayLocalNameForWriterArgumentUsage(usage);
              const identityOnlyArrayWriterArgumentUse =
                !!identityArrayWriterLocal &&
                identityArrayLocals.has(identityArrayWriterLocal);
              const arrayIdentityWriterArgumentUse =
                isArrayIdentityWriterArgumentUsage(usage);
              if (
                arrayIdentityWriterArgumentUse &&
                !identityOnlyArrayWriterArgumentUse
              ) {
                if (
                  source.arrayElement &&
                  !resolvedSource.dynamic
                ) {
                  trackReadRef(resolvedSource);
                }
                if (
                  hasRecordedIdentityUseRef(source) &&
                  !resolvedSource.dynamic
                ) {
                  recordIdentityPath(resolvedSource.root, resolvedSource.path, {
                    cellLike: isCellLikeExpression(usage),
                  });
                } else {
                  trackReadRef(resolvedSource);
                }
              } else if (
                isCallOrNewArgumentUsage(usage) ||
                isPassThroughIdentifierUsage(node) ||
                identityOnlyArrayElementUse ||
                identityOnlyArrayWriterArgumentUse
              ) {
                if (
                  resolvedSource.path.length === 0 && !resolvedSource.dynamic
                ) {
                  if (identityOnlyArgumentUse) {
                    recordIdentityPath(resolvedSource.root, [], {
                      cellLike: isCellLikeExpression(usage),
                    });
                  }
                  markPassthrough(
                    resolvedSource.root,
                    identityOnlyArgumentUse
                      ? { identityOnly: true }
                      : undefined,
                  );
                } else if (
                  identityOnlyArgumentUse && !resolvedSource.dynamic
                ) {
                  recordIdentityPath(resolvedSource.root, resolvedSource.path, {
                    cellLike: isCellLikeExpression(usage),
                  });
                } else if (
                  (identityOnlyArrayElementUse ||
                    identityOnlyArrayWriterArgumentUse) &&
                  !resolvedSource.dynamic
                ) {
                  recordIdentityPath(resolvedSource.root, resolvedSource.path, {
                    cellLike: isCellLikeExpression(usage) ||
                      !isPrimitiveLikeExpression(usage),
                  });
                } else {
                  trackReadRef(
                    resolvedSource,
                    identityOnlyArgumentUse
                      ? { identityOnly: true }
                      : undefined,
                  );
                }
              } else {
                trackReadRef(resolvedSource);
              }
            }
          }
        }
      }

      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        if (isTopmostMemberNode(node)) {
          const parent = node.parent;
          if (
            !(parent && ts.isCallExpression(parent) &&
              parent.expression === node) &&
            !isOptionalAliasInitializerMemberUsage(node) &&
            // A member-access argument (e.g. `state.auth`) whose callee parameter
            // type already supplied the capability is accounted for, same as a
            // destructured identifier; don't add a second read here.
            !signatureCapabilityArgumentUses.has(
              unwrapExpressionUsageSite(node),
            )
          ) {
            const ref = resolveSourceRef(node);
            if (ref) {
              trackReadRef(ref);
              // If this resolution went through a .get() call, record the
              // alias name so the identifier handler can skip redundant
              // blanket reads.  Only suppress for actual .get() bases —
              // ordinary member reads (e.g. state.foo) must not be tagged.
              // Walk through intermediate member accesses to find the .get()
              // call (handles chains like notes.get().meta.length).
              let getBaseExpr: ts.Expression = node.expression;
              while (
                ts.isPropertyAccessExpression(getBaseExpr) ||
                ts.isElementAccessExpression(getBaseExpr)
              ) {
                getBaseExpr = getBaseExpr.expression;
              }
              if (
                ts.isCallExpression(getBaseExpr) &&
                resolvedGetCalls.has(getBaseExpr)
              ) {
                // Unwrap the .get() call to find the root identifier:
                // notes.get() → notes.get (PropertyAccess) → notes (Identifier)
                const calleeExpr = getBaseExpr.expression;
                let rootExpr: ts.Expression = ts.isPropertyAccessExpression(
                    calleeExpr,
                  )
                  ? calleeExpr.expression
                  : calleeExpr;
                while (ts.isPropertyAccessExpression(rootExpr)) {
                  rootExpr = rootExpr.expression;
                }
                if (ts.isIdentifier(rootExpr) && aliases.has(rootExpr.text)) {
                  aliasesWithSpecificPaths.add(rootExpr.text);
                }
              }
            }
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const localReceiverName =
          ts.isPropertyAccessExpression(node.expression) ||
            ts.isElementAccessExpression(node.expression)
            ? getIdentifierName(node.expression.expression)
            : undefined;
        const localMethodName = getCallMethodName(node.expression);
        if (
          localReceiverName &&
          localMethodName &&
          ARRAY_IDENTITY_WRITER_METHODS.has(localMethodName) &&
          node.arguments.length > 0
        ) {
          recordLocalArrayIdentityWrite(
            localReceiverName,
            localMethodName === "splice"
              ? node.arguments.slice(2)
              : node.arguments,
          );
        } else if (localReceiverName && localMethodName === "set") {
          recordLocalMapSet(localReceiverName, node.arguments[1]);
        }

        const identityEqualsCall = isKnownIdentityEqualsCall(node, checker);
        const identityArgumentCall = isKnownIdentityArgumentCall(node, checker);
        const capabilityHandledArgs = new Set<number>();
        const calleeSummary = resolveInterproceduralSummary(node);
        if (calleeSummary) {
          const count = Math.min(
            calleeSummary.params.length,
            node.arguments.length,
          );
          for (let index = 0; index < count; index++) {
            const paramSummary = calleeSummary.params[index];
            const argument = node.arguments[index];
            if (!paramSummary || !argument) continue;

            const source = resolveSourceRef(argument);
            if (!source) continue;
            capabilityHandledArgs.add(index);

            if (source.dynamic || paramSummary.wildcard) {
              markWildcard(source.root);
              continue;
            }
            if (paramSummary.hasUnverifiedCellUse) {
              markUnverifiedCellUse(source.root);
            }

            for (const readPath of paramSummary.readPaths) {
              trackRead(source.root, [...source.path, ...readPath]);
            }
            for (const writePath of paramSummary.writePaths) {
              trackWrite(source.root, [...source.path, ...writePath]);
            }
            for (const opaquePath of paramSummary.opaquePaths ?? []) {
              recordOpaquePath(source.root, [
                ...source.path,
                ...opaquePath,
              ]);
            }
            if (
              paramSummary.capability === "opaque" &&
              !paramSummary.passthrough &&
              paramSummary.readPaths.length === 0 &&
              paramSummary.writePaths.length === 0 &&
              (paramSummary.opaquePaths?.length ?? 0) === 0
            ) {
              markOpaqueUse(source.root, source.path);
            }

            for (const identityPath of paramSummary.identityPaths ?? []) {
              if (source.dynamic) {
                markWildcard(source.root);
              } else {
                const isComparablePath = (paramSummary.comparablePaths ?? [])
                  .some((path) =>
                    path.length === identityPath.length &&
                    path.every((segment, index) =>
                      segment === identityPath[index]
                    )
                  );
                const recordPath = isComparablePath
                  ? recordComparablePath
                  : recordIdentityPath;
                recordPath(
                  source.root,
                  [...source.path, ...identityPath],
                  {
                    cellLike: (paramSummary.identityCellPaths ?? []).some(
                      (path) =>
                        path.length === identityPath.length &&
                        path.every((segment, index) =>
                          segment === identityPath[index]
                        ),
                    ),
                  },
                );
              }
            }

            if (paramSummary.passthrough && source.path.length === 0) {
              if (paramSummary.identityOnly) {
                if (paramSummary.capability === "comparable") {
                  recordComparablePath(source.root, []);
                } else {
                  recordIdentityPath(source.root, []);
                }
              }
              markPassthrough(
                source.root,
                paramSummary.identityOnly ? { identityOnly: true } : undefined,
              );
            }
          }
        } else if (!identityArgumentCall) {
          for (const index of applySignatureCellCapabilities(node)) {
            capabilityHandledArgs.add(index);
          }
        }

        // Optional-call forms are non-lowerable; treat as wildcard usage.
        if (node.questionDotToken && ts.isExpression(node.expression)) {
          const source = resolveSourceRef(node.expression);
          if (source) {
            markWildcard(source.root);
          }
        }

        if (
          ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)
        ) {
          const directReceiver = resolveSourceRef(node.expression.expression);
          const receiver = directReceiver ??
            resolveConservativeCallReceiverRef(node);
          if (receiver) {
            const methodName = getCallMethodName(node.expression);
            const shouldTrackFullShape = !directReceiver &&
              (!methodName || !PRECISE_CHAIN_METHODS.has(methodName));
            if (!methodName) {
              if (shouldTrackFullShape) {
                trackFullShapeReadRef(receiver);
              } else {
                trackReadRef(receiver);
              }
            } else if (methodName === "elementById") {
              // Addresses a separately derived entity; attribute the access
              // conservatively to the whole array root.
              markWildcard(receiver.root);
            } else if (methodName === "key") {
              const argPath = extractLiteralPathArguments(
                node.arguments,
                checker,
              );
              if (argPath.dynamic) {
                markWildcard(receiver.root);
              } else {
                const keyUsage = unwrapExpressionUsageSite(node);
                const keyUsageParent = keyUsage.parent;
                const isChainedIntoMemberAccess = !!(
                  keyUsageParent &&
                  (ts.isPropertyAccessExpression(keyUsageParent) ||
                    ts.isElementAccessExpression(keyUsageParent)) &&
                  keyUsageParent.expression === keyUsage
                );
                if (!isChainedIntoMemberAccess) {
                  trackReadRef({
                    root: receiver.root,
                    path: [...receiver.path, ...argPath.path],
                    dynamic: receiver.dynamic,
                  });
                }
              }
            } else if (identityEqualsCall) {
              markIdentityUseRef(receiver, node.expression.expression, {
                comparable: true,
              });
            } else if (WRITER_METHODS.has(methodName)) {
              trackWriteRef(receiver);
              recordMergeableNonAppendWrite(receiver);
            } else if (ARRAY_IDENTITY_WRITER_METHODS.has(methodName)) {
              trackWriteRef(receiver);
              if (mergeablePushMisuseSink && !receiver.dynamic) {
                if (MERGEABLE_APPEND_METHODS.has(methodName)) {
                  mergeablePushSites.push({
                    root: receiver.root,
                    encodedPath: encodePath(receiver.path),
                    node,
                  });
                } else {
                  recordMergeableNonAppendWrite(receiver);
                }
              }
              let hasIdentityArgument = false;
              for (const argument of node.arguments) {
                const argumentRef = resolveSourceRef(argument);
                const rawArgument = unwrapExpression(argument);
                const rawAlias = ts.isIdentifier(rawArgument)
                  ? aliases.get(rawArgument.text)
                  : undefined;
                if (rawAlias?.arrayElement || argumentRef?.arrayElement) {
                  trackReadRef(materializeSourceRef(rawAlias ?? argumentRef!));
                }
                if (argumentRef && hasRecordedIdentityUseRef(argumentRef)) {
                  hasIdentityArgument = true;
                  markIdentityUseRef(argumentRef, argument);
                }
              }
              if (hasIdentityArgument) {
                markArrayItemIdentityUseRef(receiver);
              }
            } else if (READER_METHODS.has(methodName)) {
              // If the .get() result was already resolved with a more specific
              // path by the member-access handler (e.g. notes.get().length →
              // ["notes", "length"]), skip the blanket read.
              if (!resolvedGetCalls.has(node)) {
                trackReadRef(receiver);
                recordMergeableReadSite(receiver, node);
              }
            } else if (
              OPAQUE_DERIVATION_METHODS.has(methodName) &&
              (
                !checker ||
                isCellLikeExpression(node.expression.expression)
              )
            ) {
              // These methods are available on opaque cells and return opaque
              // results. Dynamic receivers can hide which branch is used, so
              // they must disable shrinking for the root.
              if (receiver.dynamic) {
                markWildcard(receiver.root);
              } else if (receiver.path.length > 0) {
                recordOpaquePath(receiver.root, receiver.path);
              } else {
                markOpaqueUse(receiver.root, receiver.path);
              }
            } else {
              // Unknown method call over a tracked source reads at least the
              // receiver path. On a CELL-LIKE receiver the unknown method
              // could be a mutator this analysis does not recognize (the
              // writer sets are a closed list against an evolving Cell API),
              // so write-exhaustiveness is poisoned — fail closed. Value
              // receivers (e.g. array methods on a `.get()` snapshot) cannot
              // write through the cell and stay reads.
              if (
                !checker ||
                isCellLikeExpression(node.expression.expression)
              ) {
                markUnverifiedCellUse(receiver.root);
              }
              if (shouldTrackFullShape) {
                trackFullShapeReadRef(receiver);
              } else if (directReceiver) {
                trackReadRef(receiver);
              }
            }
          }
        }

        // Passing a tracked root object into an opaque helper can conceal
        // indirect traversal/mutation; conservatively disable shrinking.
        if (!identityArgumentCall) {
          for (let index = 0; index < node.arguments.length; index++) {
            if (capabilityHandledArgs.has(index)) {
              continue;
            }
            const argument = node.arguments[index];
            if (!argument) continue;
            const unwrappedArgument = unwrapExpression(argument);
            if (!ts.isIdentifier(unwrappedArgument)) continue;
            const source = resolveSourceRef(unwrappedArgument);
            if (!source) continue;
            if (source.dynamic || source.path.length > 0) continue;
            markWildcard(source.root);
          }
        }
        if (identityArgumentCall) {
          for (const argument of node.arguments) {
            const source = resolveSourceRef(argument);
            if (source) {
              markIdentityUseRef(source, argument, {
                comparable: identityEqualsCall,
              });
            }
          }
        }

        // Full-shape operations.
        if (isWildcardTraversalCall(node, checker)) {
          const firstArg = node.arguments[0];
          if (firstArg) {
            markWildcardFromExpression(firstArg);
          }
        }

        visitInlineEagerCallbackArguments(node);
      }

      if (ts.isNewExpression(node)) {
        applySignatureCellCapabilities(node);
      }

      if (ts.isVariableDeclaration(node)) {
        clearScopedLocalCollectionBindingNames(node.name);
        const initRef = node.initializer && ts.isExpression(node.initializer)
          ? buildAliasBindingFromExpression(node.initializer)
          : undefined;
        if (ts.isIdentifier(node.name)) {
          if (
            node.initializer &&
            ts.isExpression(node.initializer) &&
            isOptionalAliasInitializerMemberUsage(node.initializer)
          ) {
            optionalPresenceAliases.add(node.name.text);
          } else {
            optionalPresenceAliases.delete(node.name.text);
          }
        }
        assignBindingAlias(node.name, initRef);
      }

      if (
        ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ) {
        if (
          node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken
        ) {
          markFromExpression(node.operand, trackWrite);
          markFromExpression(node.operand, trackRead);
        }
      }

      if (ts.isSpreadElement(node)) {
        const spreadExpr = node.expression;
        if (spreadExpr) {
          const ref = resolveSourceRef(spreadExpr);
          if (ref) {
            trackReadRef(ref);
            const identityArrayLocal = getIdentityArrayLocalNameForElementUsage(
              node,
            );
            if (
              identityArrayLocal && identityArrayLocals.has(identityArrayLocal)
            ) {
              markArrayItemIdentityUseRef(ref);
            }
          } else {
            markWildcardFromExpression(spreadExpr);
          }
        }
      }

      if (ts.isSpreadAssignment(node)) {
        const spreadExpr = node.expression;
        if (spreadExpr) {
          markWildcardFromExpression(spreadExpr);
        }
      }

      if (ts.isForInStatement(node)) {
        markWildcardFromExpression(node.expression);
        ts.forEachChild(node, visit);
        return;
      }

      if (ts.isForOfStatement(node)) {
        const iterableExpression = unwrapExpression(node.expression);
        const iterableBinding = resolveArrayElementBinding(node.expression);
        const iterableRef =
          iterableBinding && isSourceRefBinding(iterableBinding)
            ? iterableBinding
            : undefined;
        if (iterableRef) {
          if (iterableRef.dynamic) {
            markWildcard(iterableRef.root);
          } else if (iterableRef.path.length === 0) {
            markPassthrough(iterableRef.root);
          } else {
            trackReadRef(iterableRef);
            recordMergeableReadSite(iterableRef, node.expression);
          }
          if (ts.isCallExpression(iterableExpression)) {
            visit(node.expression);
          }
        } else {
          visit(node.expression);
        }

        const savedAliases = new Map(aliases);
        const savedAliasShapes = new Map(aliasShapes);
        const savedOptionalPresenceAliases = new Set(optionalPresenceAliases);
        const savedSpecificPaths = new Set(aliasesWithSpecificPaths);
        const savedLocalArrayElementBindings = new Map(
          localArrayElementBindings,
        );
        const savedLocalMapValueBindings = new Map(localMapValueBindings);
        const scopedLocalCollectionNames = new Set<string>();
        scopedLocalCollectionNamesStack.push(scopedLocalCollectionNames);
        try {
          if (iterableBinding) {
            if (ts.isVariableDeclarationList(node.initializer)) {
              for (const declaration of node.initializer.declarations) {
                clearScopedLocalCollectionBindingNames(declaration.name);
                assignBindingAlias(declaration.name, iterableBinding);
              }
            } else if (ts.isExpression(node.initializer)) {
              assignExpressionPatternAlias(node.initializer, iterableBinding);
            }
          } else {
            visit(node.initializer);
          }
          visit(node.statement);
        } finally {
          scopedLocalCollectionNamesStack.pop();
          aliases.clear();
          for (const [name, source] of savedAliases) {
            aliases.set(name, source);
          }
          aliasShapes.clear();
          for (const [name, shape] of savedAliasShapes) {
            aliasShapes.set(name, shape);
          }
          optionalPresenceAliases.clear();
          for (const name of savedOptionalPresenceAliases) {
            optionalPresenceAliases.add(name);
          }
          aliasesWithSpecificPaths.clear();
          for (const name of savedSpecificPaths) {
            aliasesWithSpecificPaths.add(name);
          }
          restoreScopedLocalCollectionBindings(
            scopedLocalCollectionNames,
            savedLocalArrayElementBindings,
            savedLocalMapValueBindings,
          );
        }
        return;
      }

      if (ts.isBlock(node)) {
        visitScopedLocalCollectionBindings(() => {
          for (const statement of node.statements) {
            visit(statement);
          }
        });
        return;
      }

      ts.forEachChild(node, visit);
    };

    if (ts.isBlock(fn.body)) {
      for (const statement of fn.body.statements) {
        visit(statement);
      }
    } else {
      visit(fn.body);
    }

    if (mergeablePushMisuseSink && mergeablePushSites.length > 0) {
      // A push whose collection the function also reads explicitly is
      // classified by how the read relates to the push: a push that depends on
      // the read (guard or value) is the dedup-then-push shape; a read that
      // instead feeds another write to the same collection is an independent
      // read-modify-write sharing the handler; a read related to neither is
      // not reported. Influence tracking is name-based and conservative in the
      // noisy direction — ambiguity promotes to the dependent-push finding.
      const classifier = createMergeablePushClassifier({
        fn,
        readSites: mergeableReadSites,
        resolveAliasTarget: (name) => {
          const binding = aliases.get(name);
          if (!binding || binding.dynamic || binding.arrayElement) {
            return undefined;
          }
          return { root: binding.root, encodedPath: encodePath(binding.path) };
        },
      });
      for (const site of mergeablePushSites) {
        if (!states.get(site.root)?.reads.has(site.encodedPath)) continue;
        const kind = classifier.classify(
          site,
          mergeableNonAppendWriteKeys.has(
            mergeableWriteKey(site.root, site.encodedPath),
          ),
        );
        if (kind) {
          mergeablePushMisuseSink({
            node: site.node,
            path: decodePath(site.encodedPath),
            rootName: site.root,
            kind,
          });
        }
      }
    }

    const params: CapabilityParamSummary[] = [];
    for (let index = 0; index < fn.parameters.length; index++) {
      const parameter = fn.parameters[index];
      if (!parameter) continue;
      const summaryName = ts.isIdentifier(parameter.name)
        ? parameter.name.text
        : `${PARAMETER_SUMMARY_PREFIX}${index}`;
      const state = states.get(summaryName);
      if (!state) continue;
      params.push(buildCapabilityParamSummary(summaryName, state));
    }

    const result: FunctionCapabilitySummary = unreadableCellArguments.length
      ? { params, unreadableCellArguments }
      : { params };
    summaryCache.set(fn, result);
    return result;
  } finally {
    inProgress.delete(fn);
  }
}
