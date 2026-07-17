/**
 * Static Initial Value Analysis
 *
 * `Cell.of(x)` / `Writable.<scope>.of(x)` initial values are schema-level
 * defaults (CT-1880): the value is embedded as the schema `default` and every
 * session/scope observes it at read time — no document is written at
 * instantiation. That contract requires `x` to be a compile-time static value,
 * because the transformer must be able to evaluate it while lowering schemas.
 *
 * This module is the single definition of "compile-time static" for cell
 * initials. It both validates (the diagnostic transformer reports the
 * offending sub-expression on failure) and evaluates (default stamping embeds
 * the resulting JSON value into lowered schemas).
 *
 * The accepted grammar:
 * - string / number / boolean literals, `null`, `undefined` (no default),
 *   no-substitution template literals, negated static numbers
 * - arithmetic on static numbers (`10 + 20`, `60 * 60`) and `+`-concatenation
 *   of static strings, constant-folded; a fold must produce a finite number
 *   (no `1 / 0`); template literals whose substitutions are static
 * - array literals of static expressions (no spreads or holes)
 * - object literals with identifier / string / numeric / static-computed keys
 *   and static values (no spreads, accessors, or methods)
 * - static member/element access into static values (`CONFIG.max`,
 *   `PROMPTS[0].id`); a key missing from the static value is rejected
 * - parenthesized / `as` / `satisfies` wrappers around a static expression
 * - identifiers resolving to a `const` variable — local or imported from
 *   another module in the program — whose initializer is itself static
 *   (followed transitively, cycle-guarded; `let`/`var` are rejected because
 *   reassignment can change the value observed at the `.of()` site)
 *
 * Deliberately rejected: bigint literals. JSON Schema cannot carry a bigint
 * `default`, so under the schema-default contract a bigint initial has no
 * representation — initialize such cells with an explicit `cell.set(...)`.
 *
 * This is deliberately stricter than the runtime `validateStaticData` walk in
 * the runner (which rejects reactive values and cycles in the *evaluated*
 * value but cannot see whether the expression was constant — e.g.
 * `safeDateNow()` evaluates to a plain number and passes it). The runtime
 * check remains as the backstop for untransformed callers.
 */
import ts from "typescript";

/** JSON-shaped value an initial evaluates to. `undefined` means "no default". */
export type StaticInitialValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | StaticInitialValue[]
  | { [key: string]: StaticInitialValue };

export type StaticInitialResult =
  | { ok: true; value: StaticInitialValue }
  | {
    /** `expression` is the innermost non-static node — report there. */
    ok: false;
    expression: ts.Node;
    reason: string;
  };

/**
 * Evaluate a cell-factory initial-value expression to its static JSON value,
 * or identify the innermost sub-expression that is not compile-time static.
 */
export function evaluateStaticInitial(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): StaticInitialResult {
  return evaluate(expression, checker, new Set());
}

function evaluate(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  visiting: Set<ts.Declaration>,
): StaticInitialResult {
  const expr = unwrapStaticWrappers(expression);

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { ok: true, value: expr.text };
  }
  if (ts.isNumericLiteral(expr)) {
    return { ok: true, value: Number(expr.text) };
  }
  if (ts.isBigIntLiteral(expr)) {
    return {
      ok: false,
      expression: expr,
      reason: "bigint values cannot be JSON Schema defaults; " +
        "initialize the cell with `cell.set(...)` instead",
    };
  }
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken
  ) {
    const operand = evaluate(expr.operand, checker, visiting);
    if (!operand.ok) return operand;
    if (typeof operand.value !== "number") {
      return {
        ok: false,
        expression: expr,
        reason: "unary minus on a non-number is not compile-time static",
      };
    }
    return { ok: true, value: -operand.value };
  }
  if (ts.isBinaryExpression(expr)) {
    return foldBinaryExpression(expr, checker, visiting);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return { ok: true, value: true };
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { ok: true, value: false };
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return { ok: true, value: null };
  }
  if (ts.isIdentifier(expr) && expr.text === "undefined") {
    return { ok: true, value: undefined };
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const value: StaticInitialValue[] = [];
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element)) {
        return {
          ok: false,
          expression: element,
          reason: "spread elements are not compile-time static",
        };
      }
      if (ts.isOmittedExpression(element)) {
        return {
          ok: false,
          expression: element,
          reason: "array holes are not compile-time static",
        };
      }
      const result = evaluate(element, checker, visiting);
      if (!result.ok) return result;
      value.push(result.value);
    }
    return { ok: true, value };
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const value: { [key: string]: StaticInitialValue } = {};
    for (const property of expr.properties) {
      if (ts.isSpreadAssignment(property)) {
        return {
          ok: false,
          expression: property,
          reason: "spread properties are not compile-time static",
        };
      }
      let name: string | undefined;
      let initializer: ts.Expression;
      if (ts.isPropertyAssignment(property)) {
        name = staticPropertyName(property.name, checker, visiting);
        initializer = property.initializer;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        name = property.name.text;
        initializer = property.name;
      } else {
        // Methods and accessors.
        return {
          ok: false,
          expression: property,
          reason: "methods and accessors are not compile-time static",
        };
      }
      if (name === undefined) {
        return {
          ok: false,
          expression: property.name ?? property,
          reason: "computed property keys are not compile-time static",
        };
      }
      const result = evaluate(initializer, checker, visiting);
      if (!result.ok) return result;
      value[name] = result.value;
    }
    return { ok: true, value };
  }

  if (ts.isTemplateExpression(expr)) {
    let text = expr.head.text;
    for (const span of expr.templateSpans) {
      const part = evaluate(span.expression, checker, visiting);
      if (!part.ok) return part;
      if (
        typeof part.value !== "string" && typeof part.value !== "number" &&
        typeof part.value !== "boolean"
      ) {
        return {
          ok: false,
          expression: span.expression,
          reason:
            "template substitutions must be static strings, numbers, or booleans",
        };
      }
      text += String(part.value) + span.literal.text;
    }
    return { ok: true, value: text };
  }

  if (ts.isIdentifier(expr)) {
    return evaluateIdentifier(expr, checker, visiting);
  }

  // Static member access: `CONFIG.max`, `MEANING_PROMPTS[0].id` — the base
  // must itself be compile-time static, and the key a name or static
  // string/number. A key missing from the static value is rejected rather
  // than treated as `undefined`: the spelling almost certainly doesn't mean
  // "no default".
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const base = evaluate(expr.expression, checker, visiting);
    if (!base.ok) return base;
    return staticMember(expr, base.value, expr.name.text);
  }
  if (ts.isElementAccessExpression(expr)) {
    const base = evaluate(expr.expression, checker, visiting);
    if (!base.ok) return base;
    const key = evaluate(expr.argumentExpression, checker, visiting);
    if (!key.ok) return key;
    if (typeof key.value !== "string" && typeof key.value !== "number") {
      return {
        ok: false,
        expression: expr.argumentExpression,
        reason: "element access keys must be static strings or numbers",
      };
    }
    return staticMember(expr, base.value, String(key.value));
  }

  return {
    ok: false,
    expression: expr,
    reason: describeNonStatic(expr),
  };
}

function staticMember(
  expr: ts.Expression,
  base: StaticInitialValue,
  key: string,
): StaticInitialResult {
  const container = base as Record<string, StaticInitialValue> | null;
  const value =
    container !== null && (typeof base === "object") && key in container
      ? container[key]
      : undefined;
  if (value === undefined) {
    return {
      ok: false,
      expression: expr,
      reason: `\`${key}\` is not present on the static value`,
    };
  }
  return { ok: true, value };
}

/**
 * Strip wrappers that cannot change the runtime value: parentheses,
 * `as` / `satisfies` / angle-bracket assertions, and non-null assertions.
 */
function unwrapStaticWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function evaluateIdentifier(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  visiting: Set<ts.Declaration>,
): StaticInitialResult {
  let symbol = checker.getSymbolAtLocation(identifier);
  // Follow import aliases so a `const` exported from another module in the
  // same program (`import { DEFAULT_SPOTS } from ...`) evaluates like a
  // local one.
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) {
    return {
      ok: false,
      expression: identifier,
      reason: `cannot resolve \`${identifier.text}\` to a declaration`,
    };
  }
  if (visiting.has(declaration)) {
    return {
      ok: false,
      expression: identifier,
      reason: `\`${identifier.text}\` is circularly defined`,
    };
  }
  if (!ts.isVariableDeclaration(declaration)) {
    return {
      ok: false,
      expression: identifier,
      reason:
        `\`${identifier.text}\` is not a \`const\` variable with a static initializer`,
    };
  }
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) {
    return {
      ok: false,
      expression: identifier,
      reason:
        `\`${identifier.text}\` is declared with \`let\`/\`var\`; only \`const\` values can be compile-time static`,
    };
  }
  if (declaration.initializer === undefined) {
    // Ambient consts (`export declare const NAME: "$NAME"`) carry their value
    // in the declared literal TYPE.
    const type = checker.getTypeAtLocation(declaration);
    if (type.isStringLiteral()) return { ok: true, value: type.value };
    if (type.isNumberLiteral()) return { ok: true, value: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return {
        ok: true,
        value: (type as ts.Type & { intrinsicName?: string })
          .intrinsicName === "true",
      };
    }
    return {
      ok: false,
      expression: identifier,
      reason: `\`${identifier.text}\` has no initializer`,
    };
  }
  visiting.add(declaration);
  const result = evaluate(declaration.initializer, checker, visiting);
  visiting.delete(declaration);
  if (!result.ok) {
    // Report at the *use* site, which is inside the `.of()` argument the user
    // is looking at, but keep the underlying reason from the initializer.
    return {
      ok: false,
      expression: identifier,
      reason:
        `\`${identifier.text}\` is a \`const\`, but its initializer is not compile-time static: ${result.reason}`,
    };
  }
  return result;
}

/**
 * Constant-fold arithmetic on static numbers and `+`-concatenation of static
 * strings. Anything else — comparisons, logic, bitwise, mixed-type `+` — is
 * rejected: the goal is to keep the documented `cell(10 + 20)` spelling
 * working, not to grow an expression evaluator.
 */
function foldBinaryExpression(
  expr: ts.BinaryExpression,
  checker: ts.TypeChecker,
  visiting: Set<ts.Declaration>,
): StaticInitialResult {
  const op = expr.operatorToken.kind;
  const numericOps = new Map<ts.SyntaxKind, (a: number, b: number) => number>([
    [ts.SyntaxKind.PlusToken, (a, b) => a + b],
    [ts.SyntaxKind.MinusToken, (a, b) => a - b],
    [ts.SyntaxKind.AsteriskToken, (a, b) => a * b],
    [ts.SyntaxKind.SlashToken, (a, b) => a / b],
    [ts.SyntaxKind.PercentToken, (a, b) => a % b],
    [ts.SyntaxKind.AsteriskAsteriskToken, (a, b) => a ** b],
  ]);
  if (!numericOps.has(op)) {
    return {
      ok: false,
      expression: expr,
      reason: "computed expressions are not compile-time static",
    };
  }
  const left = evaluate(expr.left, checker, visiting);
  if (!left.ok) return left;
  const right = evaluate(expr.right, checker, visiting);
  if (!right.ok) return right;

  if (
    op === ts.SyntaxKind.PlusToken && typeof left.value === "string" &&
    typeof right.value === "string"
  ) {
    return { ok: true, value: left.value + right.value };
  }
  if (typeof left.value !== "number" || typeof right.value !== "number") {
    return {
      ok: false,
      expression: expr,
      reason: "arithmetic on non-numbers is not compile-time static",
    };
  }
  const folded = numericOps.get(op)!(left.value, right.value);
  if (!Number.isFinite(folded)) {
    return {
      ok: false,
      expression: expr,
      reason:
        "this expression does not fold to a finite number, so it cannot be a JSON Schema default",
    };
  }
  return { ok: true, value: folded };
}

function staticPropertyName(
  name: ts.PropertyName,
  checker: ts.TypeChecker,
  visiting: Set<ts.Declaration>,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) {
    return name.text;
  }
  // A computed key is fine when the key expression itself is static
  // (`{ [MENTION_KEY]: ... }`).
  if (ts.isComputedPropertyName(name)) {
    const key = evaluate(name.expression, checker, visiting);
    if (
      key.ok &&
      (typeof key.value === "string" || typeof key.value === "number")
    ) {
      return String(key.value);
    }
  }
  return undefined;
}

function describeNonStatic(expr: ts.Expression): string {
  if (ts.isCallExpression(expr)) {
    return "function calls are evaluated at runtime, not compile time";
  }
  if (
    ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)
  ) {
    return "property accesses are not compile-time static";
  }
  if (ts.isTemplateExpression(expr)) {
    return "template literals with substitutions are not compile-time static";
  }
  if (ts.isBinaryExpression(expr) || ts.isConditionalExpression(expr)) {
    return "computed expressions are not compile-time static";
  }
  if (ts.isNewExpression(expr)) {
    return "constructed objects are not compile-time static";
  }
  return "this expression is not compile-time static";
}
