import ts from "typescript";
import {
  classifyArrayCallbackContainerCall,
  isCellLikeType,
  isWildcardTraversalCall,
} from "../ast/mod.ts";
import {
  type CapabilityParamSummary,
  type FunctionCapabilitySummary,
  type ReactiveCapability,
  resolvesToCommonFabricSymbol,
} from "../core/mod.ts";
import { getKnownComputedKeyPathSegment } from "../utils/reactive-keys.ts";
import { decodePath, encodePath } from "../utils/path-serialization.ts";
import { unwrapExpression } from "../utils/expression.ts";

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
}

interface MutableCapabilityState {
  readonly reads: Set<string>;
  readonly fullShapeReads: Set<string>;
  readonly writes: Set<string>;
  readonly rawIdentityPaths: Set<string>;
  readonly rawIdentityCellPaths: Set<string>;
  passthrough: boolean;
  wildcard: boolean;
  hasIdentityUse: boolean;
  hasNonIdentityUse: boolean;
  hasNonIdentityRootUse: boolean;
}

interface ObservedCapabilityUsage {
  readonly readPaths: readonly (readonly string[])[];
  readonly fullShapePaths: readonly (readonly string[])[];
  readonly writePaths: readonly (readonly string[])[];
  readonly passthrough: boolean;
  readonly wildcard: boolean;
  readonly identityOnly: boolean;
  readonly identityPaths: readonly (readonly string[])[];
  readonly identityCellPaths: readonly (readonly string[])[];
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

const WRITER_METHODS = new Set(["set", "update"]);
const READER_METHODS = new Set(["get"]);
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

function isKnownIdentityEqualsCallee(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): boolean {
  const current = unwrapExpression(expr);

  if (ts.isIdentifier(current)) {
    if (!checker) {
      return current.text === "equals";
    }
    const symbol = checker.getSymbolAtLocation(current);
    return resolvesToCommonFabricSymbol(symbol, checker, "equals");
  }

  if (ts.isPropertyAccessExpression(current)) {
    if (current.name.text !== "equals") {
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
    if (getLiteralElementText(current.argumentExpression) !== "equals") {
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
  return "opaque";
}

function normalizeObservedCapabilityUsage(
  state: MutableCapabilityState,
): ObservedCapabilityUsage {
  const readPaths = Array.from(state.reads).map(decodePath);
  const fullShapePaths = Array.from(state.fullShapeReads).map(decodePath);
  const writePaths = Array.from(state.writes).map(decodePath);
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

  return {
    readPaths,
    fullShapePaths,
    writePaths,
    passthrough: state.passthrough,
    wildcard: state.wildcard,
    identityOnly: identityPaths.some((path) => path.length === 0) &&
      !state.hasNonIdentityUse &&
      state.reads.size === 0 &&
      state.writes.size === 0 &&
      !state.wildcard,
    identityPaths,
    identityCellPaths,
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
    const interprocedural = !!options?.interprocedural && !!checker;
    const includeNestedCallbacks = !!options?.includeNestedCallbacks;
    const summarySourceFile = fn.getSourceFile();

    if (!fn.body) {
      const empty = { params: [] };
      summaryCache.set(fn, empty);
      return empty;
    }

    const states = new Map<string, MutableCapabilityState>();
    const aliases = new Map<string, SourceRef>();
    const aliasShapes = new Map<string, AliasShape>();
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
          passthrough: false,
          wildcard: false,
          hasIdentityUse: false,
          hasNonIdentityUse: false,
          hasNonIdentityRootUse: false,
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

    const isCellLikeExpression = (expr: ts.Expression): boolean => {
      if (!checker) {
        return false;
      }
      return isCellLikeType(checker.getTypeAtLocation(expr), checker);
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

    const recordLocalArrayPush = (
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
    ): void => {
      const cellLike = expr ? isCellLikeExpression(expr) : false;
      if (ref.dynamic) {
        markWildcard(ref.root);
      } else if (ref.path.length === 0) {
        recordIdentityPath(ref.root, [], { cellLike });
        markPassthrough(ref.root, { identityOnly: true });
      } else {
        recordIdentityPath(ref.root, ref.path, { cellLike });
      }
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
        interprocedural: true,
        summaryCache,
        inProgress,
      });
    };

    const visitScopedFunctionBody = (
      callback: CapabilityAnalyzableFunction,
      paramBindings?: ReadonlyMap<number, AliasBinding>,
    ): void => {
      const savedAliases = new Map(aliases);
      const savedAliasShapes = new Map(aliasShapes);
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
                isKnownIdentityEqualsCall(parent, checker)
              );
              if (
                isCallOrNewArgumentUsage(usage) ||
                isPassThroughIdentifierUsage(node)
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
              parent.expression === node)
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
          localMethodName === "push" &&
          node.arguments.length > 0
        ) {
          recordLocalArrayPush(localReceiverName, node.arguments);
        } else if (localReceiverName && localMethodName === "set") {
          recordLocalMapSet(localReceiverName, node.arguments[1]);
        }

        const identityEqualsCall = isKnownIdentityEqualsCall(node, checker);
        const interproceduralHandledArgs = new Set<number>();
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
            interproceduralHandledArgs.add(index);

            if (source.dynamic || paramSummary.wildcard) {
              markWildcard(source.root);
              continue;
            }

            for (const readPath of paramSummary.readPaths) {
              trackRead(source.root, [...source.path, ...readPath]);
            }
            for (const writePath of paramSummary.writePaths) {
              trackWrite(source.root, [...source.path, ...writePath]);
            }

            for (const identityPath of paramSummary.identityPaths ?? []) {
              if (source.dynamic) {
                markWildcard(source.root);
              } else {
                recordIdentityPath(
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
                recordIdentityPath(source.root, []);
              }
              markPassthrough(
                source.root,
                paramSummary.identityOnly ? { identityOnly: true } : undefined,
              );
            }
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
              markIdentityUseRef(receiver, node.expression.expression);
            } else if (WRITER_METHODS.has(methodName)) {
              trackWriteRef(receiver);
            } else if (READER_METHODS.has(methodName)) {
              // If the .get() result was already resolved with a more specific
              // path by the member-access handler (e.g. notes.get().length →
              // ["notes", "length"]), skip the blanket read.
              if (!resolvedGetCalls.has(node)) {
                trackReadRef(receiver);
              }
            } else {
              // Unknown method call over a tracked source reads at least the receiver path.
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
        if (!identityEqualsCall) {
          for (let index = 0; index < node.arguments.length; index++) {
            if (interproceduralHandledArgs.has(index)) {
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
        if (identityEqualsCall) {
          for (const argument of node.arguments) {
            const source = resolveSourceRef(argument);
            if (source) {
              markIdentityUseRef(source, argument);
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

      if (ts.isVariableDeclaration(node)) {
        clearScopedLocalCollectionBindingNames(node.name);
        const initRef = node.initializer && ts.isExpression(node.initializer)
          ? buildAliasBindingFromExpression(node.initializer)
          : undefined;
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

      if (
        ts.isSpreadElement(node) ||
        ts.isSpreadAssignment(node)
      ) {
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
          }
          if (ts.isCallExpression(iterableExpression)) {
            visit(node.expression);
          }
        } else {
          visit(node.expression);
        }

        const savedAliases = new Map(aliases);
        const savedAliasShapes = new Map(aliasShapes);
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

    const result = { params };
    summaryCache.set(fn, result);
    return result;
  } finally {
    inProgress.delete(fn);
  }
}
