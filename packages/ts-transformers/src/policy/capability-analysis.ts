import ts from "typescript";
import type {
  CapabilityParamSummary,
  FunctionCapabilitySummary,
  ReactiveCapability,
} from "../core/mod.ts";
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
  readonly summaryCache?: WeakMap<ts.Node, FunctionCapabilitySummary>;
  readonly inProgress?: WeakSet<ts.Node>;
}

interface MutableCapabilityState {
  readonly reads: Set<string>;
  readonly writes: Set<string>;
  passthrough: boolean;
  wildcard: boolean;
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
}

const PARAMETER_SUMMARY_PREFIX = "__param";

const WRITER_METHODS = new Set(["set", "update"]);
const READER_METHODS = new Set(["get"]);
const WILDCARD_OBJECT_METHODS = new Set(["keys", "values", "entries"]);
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
    return { path, dynamic: true };
  }
  return { path, dynamic: false };
}

function extractAccessPath(expr: ts.Expression): AccessPathInfo | undefined {
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
        dynamic = true;
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

function clearBindingAliases(
  name: ts.BindingName,
  aliases: Map<string, SourceRef>,
): void {
  if (ts.isIdentifier(name)) {
    aliases.delete(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    clearBindingAliases(element.name, aliases);
  }
}

function assignParameterBindingAlias(
  name: ts.BindingName,
  source: SourceRef | undefined,
  aliases: Map<string, SourceRef>,
  markWildcard: (name: string) => void,
): void {
  if (ts.isIdentifier(name)) {
    if (source) {
      aliases.set(name.text, source);
    } else {
      aliases.delete(name.text);
    }
    return;
  }

  if (!source) {
    clearBindingAliases(name, aliases);
    return;
  }

  if (ts.isArrayBindingPattern(name)) {
    markWildcard(source.root);
    clearBindingAliases(name, aliases);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;

    if (element.dotDotDotToken || element.initializer) {
      markWildcard(source.root);
      clearBindingAliases(element.name, aliases);
      continue;
    }

    let key: string | undefined;
    if (!element.propertyName) {
      if (ts.isIdentifier(element.name)) {
        key = element.name.text;
      }
    } else if (ts.isIdentifier(element.propertyName)) {
      key = element.propertyName.text;
    } else if (ts.isStringLiteral(element.propertyName)) {
      key = element.propertyName.text;
    } else if (ts.isNumericLiteral(element.propertyName)) {
      key = element.propertyName.text;
    } else {
      markWildcard(source.root);
    }

    if (!key) {
      clearBindingAliases(element.name, aliases);
      continue;
    }

    assignParameterBindingAlias(
      element.name,
      {
        root: source.root,
        path: [...source.path, key],
        dynamic: source.dynamic,
      },
      aliases,
      markWildcard,
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

  const checker = options?.checker;
  const interprocedural = !!options?.interprocedural && !!checker;

  if (!fn.body) {
    const empty = { params: [] };
    summaryCache.set(fn, empty);
    inProgress.delete(fn);
    return empty;
  }

  const states = new Map<string, MutableCapabilityState>();
  const aliases = new Map<string, SourceRef>();
  const parameterStateKeys: string[] = [];

  const ensureState = (name: string): MutableCapabilityState => {
    let state = states.get(name);
    if (!state) {
      state = {
        reads: new Set<string>(),
        writes: new Set<string>(),
        passthrough: false,
        wildcard: false,
      };
      states.set(name, state);
    }
    return state;
  };

  const trackRead = (name: string, path: readonly string[]): void => {
    ensureState(name).reads.add(encodePath(path));
  };

  const trackWrite = (name: string, path: readonly string[]): void => {
    ensureState(name).writes.add(encodePath(path));
  };

  const markWildcard = (name: string): void => {
    ensureState(name).wildcard = true;
  };

  const markPassthrough = (name: string): void => {
    ensureState(name).passthrough = true;
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
      markWildcard,
    );
  }

  if (parameterStateKeys.length === 0) {
    const empty = { params: [] };
    summaryCache.set(fn, empty);
    inProgress.delete(fn);
    return empty;
  }

  const resolveFromAccess = (
    expression: ts.Expression,
  ): SourceRef | undefined => {
    const info = extractAccessPath(expression);
    if (!info) return undefined;
    const alias = aliases.get(info.root);
    if (!alias) return undefined;
    return {
      root: alias.root,
      path: [...alias.path, ...info.path],
      dynamic: alias.dynamic || info.dynamic,
    };
  };

  const resolveSourceRef = (
    expression: ts.Expression,
  ): SourceRef | undefined => {
    const current = unwrapExpression(expression);
    const byAccess = resolveFromAccess(current);
    if (byAccess) return byAccess;

    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression)
    ) {
      const receiverRef = resolveSourceRef(current.expression.expression);
      if (!receiverRef) return undefined;

      const methodName = current.expression.name.text;
      if (methodName === "get" && current.arguments.length === 0) {
        return receiverRef;
      }
      if (methodName === "key") {
        const argPath = extractLiteralPathArguments(current.arguments);
        if (argPath.dynamic) {
          return { ...receiverRef, dynamic: true };
        }
        return {
          root: receiverRef.root,
          path: [...receiverRef.path, ...argPath.path],
          dynamic: receiverRef.dynamic,
        };
      }
    }

    return undefined;
  };

  const trackReadRef = (ref: SourceRef): void => {
    if (ref.dynamic) {
      markWildcard(ref.root);
      return;
    }
    trackRead(ref.root, ref.path);
  };

  const trackWriteRef = (ref: SourceRef): void => {
    if (ref.dynamic) {
      markWildcard(ref.root);
      return;
    }
    trackWrite(ref.root, ref.path);
  };

  const assignBindingAlias = (
    name: ts.BindingName,
    source: SourceRef | undefined,
  ): void => {
    if (ts.isIdentifier(name)) {
      if (source) {
        aliases.set(name.text, source);
      } else {
        aliases.delete(name.text);
      }
      return;
    }

    if (!source) {
      clearBindingAliases(name, aliases);
      return;
    }

    if (ts.isArrayBindingPattern(name)) {
      markWildcard(source.root);
      clearBindingAliases(name, aliases);
      return;
    }

    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;

      if (element.dotDotDotToken || element.initializer) {
        markWildcard(source.root);
        clearBindingAliases(element.name, aliases);
        continue;
      }

      let key: string | undefined;
      if (!element.propertyName) {
        if (ts.isIdentifier(element.name)) {
          key = element.name.text;
        }
      } else if (ts.isIdentifier(element.propertyName)) {
        key = element.propertyName.text;
      } else if (ts.isStringLiteral(element.propertyName)) {
        key = element.propertyName.text;
      } else if (ts.isNumericLiteral(element.propertyName)) {
        key = element.propertyName.text;
      } else {
        markWildcard(source.root);
      }

      if (!key) {
        clearBindingAliases(element.name, aliases);
        continue;
      }

      trackRead(source.root, [...source.path, key]);
      assignBindingAlias(element.name, {
        root: source.root,
        path: [...source.path, key],
        dynamic: source.dynamic,
      });
    }
  };

  const assignExpressionPatternAlias = (
    pattern: ts.Expression,
    source: SourceRef | undefined,
  ): void => {
    if (ts.isParenthesizedExpression(pattern)) {
      assignExpressionPatternAlias(pattern.expression, source);
      return;
    }

    if (ts.isIdentifier(pattern)) {
      if (source) {
        aliases.set(pattern.text, source);
      } else {
        aliases.delete(pattern.text);
      }
      return;
    }

    if (ts.isObjectLiteralExpression(pattern)) {
      if (!source) {
        for (const property of pattern.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            aliases.delete(property.name.text);
          } else if (ts.isPropertyAssignment(property)) {
            assignExpressionPatternAlias(property.initializer, undefined);
          }
        }
        return;
      }

      for (const property of pattern.properties) {
        if (ts.isSpreadAssignment(property)) {
          markWildcard(source.root);
          continue;
        }

        if (ts.isShorthandPropertyAssignment(property)) {
          trackRead(source.root, [...source.path, property.name.text]);
          aliases.set(property.name.text, {
            root: source.root,
            path: [...source.path, property.name.text],
            dynamic: source.dynamic,
          });
          continue;
        }

        if (!ts.isPropertyAssignment(property)) {
          continue;
        }

        let key: string | undefined;
        if (ts.isIdentifier(property.name)) {
          key = property.name.text;
        } else if (ts.isStringLiteral(property.name)) {
          key = property.name.text;
        } else if (ts.isNumericLiteral(property.name)) {
          key = property.name.text;
        } else {
          markWildcard(source.root);
        }

        if (!key) {
          assignExpressionPatternAlias(property.initializer, undefined);
          continue;
        }

        trackRead(source.root, [...source.path, key]);
        assignExpressionPatternAlias(property.initializer, {
          root: source.root,
          path: [...source.path, key],
          dynamic: source.dynamic,
        });
      }
      return;
    }

    if (ts.isArrayLiteralExpression(pattern)) {
      if (source) {
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

  const resolveInterproceduralSummary = (
    call: ts.CallExpression,
  ): FunctionCapabilitySummary | undefined => {
    if (!interprocedural || !checker) return undefined;
    const signature = checker.getResolvedSignature(call);
    if (!signature) return undefined;
    const declaration = signature.declaration;
    if (!isCapabilityAnalyzableFunction(declaration)) {
      return undefined;
    }

    return analyzeFunctionCapabilities(declaration, {
      checker,
      interprocedural: true,
      summaryCache,
      inProgress,
    });
  };

  const visit = (node: ts.Node): void => {
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
          const nextRef = resolveSourceRef(node.right);
          if (nextRef) {
            aliases.set(node.left.text, nextRef);
          } else {
            aliases.delete(node.left.text);
          }
        } else if (
          ts.isObjectLiteralExpression(node.left) ||
          ts.isArrayLiteralExpression(node.left)
        ) {
          const nextRef = resolveSourceRef(node.right);
          assignExpressionPatternAlias(node.left, nextRef);
        } else {
          markFromExpression(node.left, trackWrite);
        }
      } else {
        if (ts.isIdentifier(node.left)) {
          aliases.delete(node.left.text);
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
          const usage = unwrapIdentifierUsageSite(node);
          const parent = usage.parent;
          if (!parent) {
            // Synthetic identifiers can temporarily be detached from parent links.
            // Preserve narrowed-path reads while avoiding false root-read expansion.
            if (!source.dynamic && source.path.length === 0) {
              markPassthrough(source.root);
            } else {
              trackReadRef(source);
            }
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
            if (
              isCallOrNewArgumentUsage(usage) ||
              isPassThroughIdentifierUsage(node)
            ) {
              if (source.path.length === 0 && !source.dynamic) {
                markPassthrough(source.root);
              } else {
                trackReadRef(source);
              }
            } else {
              trackReadRef(source);
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
          !(parent && ts.isCallExpression(parent) && parent.expression === node)
        ) {
          const ref = resolveSourceRef(node);
          if (ref) {
            trackReadRef(ref);
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
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

          if (paramSummary.passthrough && source.path.length === 0) {
            markPassthrough(source.root);
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

      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = resolveSourceRef(node.expression.expression);
        if (receiver) {
          const methodName = node.expression.name.text;
          if (methodName === "key") {
            const argPath = extractLiteralPathArguments(node.arguments);
            if (argPath.dynamic) {
              markWildcard(receiver.root);
            }
          } else if (WRITER_METHODS.has(methodName)) {
            trackWriteRef(receiver);
          } else if (READER_METHODS.has(methodName)) {
            trackReadRef(receiver);
          } else {
            // Unknown method call over a tracked source reads at least the receiver path.
            trackReadRef(receiver);
          }
        }
      }

      // Passing a tracked root object into an opaque helper can conceal
      // indirect traversal/mutation; conservatively disable shrinking.
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

      // Full-shape operations.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        WILDCARD_OBJECT_METHODS.has(node.expression.name.text)
      ) {
        const firstArg = node.arguments[0];
        if (firstArg) {
          markWildcardFromExpression(firstArg);
        }
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "JSON" &&
        node.expression.name.text === "stringify"
      ) {
        const firstArg = node.arguments[0];
        if (firstArg) {
          markWildcardFromExpression(firstArg);
        }
      }
    }

    if (ts.isVariableDeclaration(node)) {
      const initRef = node.initializer && ts.isExpression(node.initializer)
        ? resolveSourceRef(node.initializer)
        : undefined;
      assignBindingAlias(node.name, initRef);
    }

    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
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

    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      markWildcardFromExpression(node.expression);
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
    params.push({
      name: summaryName,
      capability: toCapability(state),
      readPaths: Array.from(state.reads).map(decodePath),
      writePaths: Array.from(state.writes).map(decodePath),
      passthrough: state.passthrough,
      wildcard: state.wildcard,
    });
  }

  const result = { params };
  summaryCache.set(fn, result);
  inProgress.delete(fn);
  return result;
}
