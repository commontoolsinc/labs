import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import { createCaptureAccessExpression } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  getUniqueIdentifier,
  maybeReuseIdentifier,
  normalizeBindingName,
} from "../../utils/identifiers.ts";
import { createDeriveCall } from "../../transformers/builtins/derive.ts";
import { visitEachChildWithJsx } from "../../ast/mod.ts";

function isBindingPattern(name: ts.BindingName): name is ts.BindingPattern {
  return ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name);
}

export interface ComputedAliasInfo {
  readonly symbol: ts.Symbol;
  readonly aliasName: string;
  readonly keyExpression: ts.Expression;
  readonly keyIdentifier: ts.Identifier;
  readonly path: readonly string[];
  readonly baseTemplate?: ts.Expression;
}

export interface ElementBindingAnalysis {
  readonly bindingName: ts.BindingName;
  readonly elementIdentifier: ts.Identifier;
  readonly computedAliases: readonly ComputedAliasInfo[];
  readonly destructureStatement?: ts.Statement;
}

interface ElementBindingPlan {
  readonly aliases: ComputedAliasInfo[];
  readonly residualPattern?: ts.BindingName;
}

function buildElementBindingPlan(
  elemParam: ts.ParameterDeclaration,
  context: TransformationContext,
): ElementBindingPlan {
  const { factory, checker } = context;

  const aliasBucket: ComputedAliasInfo[] = [];
  const keyNames = new Set<string>();

  const walk = (
    node: ts.BindingName,
    path: readonly string[],
    template: ts.Expression | undefined,
  ): ts.BindingName | undefined => {
    if (ts.isIdentifier(node)) {
      return factory.createIdentifier(node.text);
    }

    if (ts.isObjectBindingPattern(node)) {
      const elements: ts.BindingElement[] = [];

      for (const element of node.elements) {
        const propertyName = element.propertyName;
        let nextPath = path;
        let nextTemplate = template;

        if (propertyName && ts.isComputedPropertyName(propertyName)) {
          if (ts.isIdentifier(element.name)) {
            const symbol = checker.getSymbolAtLocation(element.name);
            if (symbol) {
              const aliasName = element.name.text;
              const keyBase = `__ct_${aliasName}_key`;
              const unique = getUniqueIdentifier(keyBase, keyNames, {
                fallback: keyBase,
              });
              keyNames.add(unique);
              aliasBucket.push({
                symbol,
                aliasName,
                keyExpression: propertyName.expression,
                keyIdentifier: factory.createIdentifier(unique),
                path,
                baseTemplate: template,
              });
            }
          }
          continue;
        }

        if (propertyName && ts.isIdentifier(propertyName)) {
          nextPath = [...path, propertyName.text];
          const base = nextTemplate ??
            factory.createIdentifier("__ct_placeholder");
          nextTemplate = factory.createPropertyAccessExpression(
            base,
            factory.createIdentifier(propertyName.text),
          );
        } else if (propertyName && ts.isStringLiteral(propertyName)) {
          nextPath = [...path, propertyName.text];
          const base = nextTemplate ??
            factory.createIdentifier("__ct_placeholder");
          nextTemplate = factory.createElementAccessExpression(
            base,
            factory.createStringLiteral(propertyName.text),
          );
        } else if (!propertyName && ts.isIdentifier(element.name)) {
          nextPath = [...path, element.name.text];
          const base = nextTemplate ??
            factory.createIdentifier("__ct_placeholder");
          nextTemplate = factory.createPropertyAccessExpression(
            base,
            factory.createIdentifier(element.name.text),
          );
        }

        let clonedName: ts.BindingName | undefined;
        if (ts.isIdentifier(element.name)) {
          clonedName = factory.createIdentifier(element.name.text);
        } else if (isBindingPattern(element.name)) {
          clonedName = walk(element.name, nextPath, nextTemplate);
        }

        if (!clonedName && !element.dotDotDotToken) {
          continue;
        }

        elements.push(
          factory.createBindingElement(
            element.dotDotDotToken,
            element.propertyName,
            clonedName ?? element.name,
            element.initializer as ts.Expression | undefined,
          ),
        );
      }

      if (elements.length === 0) return undefined;
      return factory.createObjectBindingPattern(elements);
    }

    if (ts.isArrayBindingPattern(node)) {
      const newElements = node.elements.map((element) => {
        if (ts.isOmittedExpression(element)) return element;
        if (ts.isBindingElement(element)) {
          let clonedName: ts.BindingName | undefined;
          if (ts.isIdentifier(element.name)) {
            clonedName = factory.createIdentifier(element.name.text);
          } else if (isBindingPattern(element.name)) {
            clonedName = walk(element.name, path, template);
          }
          if (!clonedName && !element.dotDotDotToken) {
            return element;
          }
          return factory.createBindingElement(
            element.dotDotDotToken,
            element.propertyName,
            clonedName ?? element.name,
            element.initializer as ts.Expression | undefined,
          );
        }
        return element;
      });
      return factory.createArrayBindingPattern(newElements);
    }

    return undefined;
  };

  const residualPattern = walk(elemParam.name, [], undefined);

  return {
    aliases: aliasBucket,
    residualPattern,
  };
}

export function analyzeElementBinding(
  elemParam: ts.ParameterDeclaration | undefined,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
  used: Set<string>,
  createBindingIdentifier: (candidate: string) => ts.Identifier,
): ElementBindingAnalysis {
  const { factory } = context;

  if (!elemParam) {
    const identifier = createBindingIdentifier(
      captureTree.has("element") ? "__ct_element" : "element",
    );
    return {
      bindingName: identifier,
      elementIdentifier: identifier,
      computedAliases: [],
    };
  }

  if (ts.isIdentifier(elemParam.name)) {
    const identifier = maybeReuseIdentifier(elemParam.name, used);
    return {
      bindingName: identifier,
      elementIdentifier: identifier,
      computedAliases: [],
    };
  }

  const plan = buildElementBindingPlan(elemParam, context);

  if (plan.aliases.length === 0) {
    const normalized = normalizeBindingName(
      elemParam.name,
      factory,
      used,
    );
    return {
      bindingName: normalized,
      elementIdentifier: factory.createIdentifier(
        ts.isIdentifier(normalized) ? normalized.text : "element",
      ),
      computedAliases: [],
    };
  }

  const elementIdentifier = createBindingIdentifier(
    captureTree.has("element") ? "__ct_element" : "element",
  );

  let destructureStatement: ts.Statement | undefined;
  if (plan.residualPattern) {
    const normalized = normalizeBindingName(
      plan.residualPattern,
      factory,
      used,
    );
    destructureStatement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            normalized,
            undefined,
            undefined,
            factory.createIdentifier(elementIdentifier.text),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );
  }

  return {
    bindingName: elementIdentifier,
    elementIdentifier,
    computedAliases: plan.aliases,
    destructureStatement,
  };
}

function createDerivedAliasExpression(
  info: ComputedAliasInfo,
  elementIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression {
  const { factory, ctHelpers, tsContext } = context;
  const keyIdent = factory.createIdentifier(info.keyIdentifier.text);

  const accessBase = createCaptureAccessExpression(
    elementIdentifier.text,
    info.path,
    factory,
    info.baseTemplate,
  );

  const elementAccess = factory.createElementAccessExpression(
    accessBase,
    keyIdent,
  );

  const elementRef = factory.createIdentifier(elementIdentifier.text);

  const deriveExpression = createDeriveCall(
    elementAccess,
    [elementRef, keyIdent],
    {
      factory,
      tsContext,
      ctHelpers,
      context,
    },
  );

  return deriveExpression ?? elementAccess;
}

export function rewriteCallbackBody(
  body: ts.ConciseBody,
  analysis: ElementBindingAnalysis,
  context: TransformationContext,
): ts.ConciseBody {
  if (analysis.computedAliases.length === 0) {
    return body;
  }

  const { factory } = context;

  let block: ts.Block;
  if (ts.isBlock(body)) {
    block = body;
  } else {
    block = factory.createBlock([
      factory.createReturnStatement(body as ts.Expression),
    ], true);
  }

  const prologue: ts.Statement[] = [];

  if (analysis.destructureStatement) {
    prologue.push(analysis.destructureStatement);
  }

  for (const info of analysis.computedAliases) {
    prologue.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier(info.aliasName),
              undefined,
              undefined,
              createDerivedAliasExpression(
                info,
                analysis.elementIdentifier,
                context,
              ),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
    );
  }

  const statements: ts.Statement[] = [...prologue, ...block.statements];

  const keyStatements: ts.Statement[] = [];
  for (const info of analysis.computedAliases) {
    keyStatements.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier(info.keyIdentifier.text),
              undefined,
              undefined,
              info.keyExpression,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
    );
  }

  if (keyStatements.length > 0) {
    statements.unshift(...keyStatements);
  }

  return factory.createBlock(statements, true);
}

/**
 * Configuration for wrapping template literals in derive calls.
 */
export interface TemplateLiteralWrapConfig {
  /** Names of opaque identifiers from captures (e.g., "state", "config") */
  readonly captureRoots: ReadonlySet<string>;
  /** Name of the element parameter (e.g., "item", "element") */
  readonly elementName: string;
}

/**
 * Walk a body and wrap template literals that use opaque refs with the `str` tag.
 *
 * Transforms: `Hello, ${state.prefix}-${item.name}!`
 * To: str`Hello, ${state.prefix}-${item.name}!`
 *
 * The `str` template tag uses lift() internally, which properly unwraps
 * opaque refs. This avoids the Symbol.toPrimitive error that occurs when
 * template literals try to coerce opaque refs to primitives.
 */
export function wrapTemplateLiteralsInDerive(
  body: ts.ConciseBody,
  config: TemplateLiteralWrapConfig,
  context: TransformationContext,
): ts.ConciseBody {
  const { factory } = context;

  // If no opaque roots configured, nothing to transform
  if (config.captureRoots.size === 0 && !config.elementName) {
    return body;
  }

  /**
   * Visitor that transforms template literals containing opaque refs.
   */
  const transformTemplateLiterals = (node: ts.Node): ts.Node => {
    // Handle TemplateExpression (template with interpolations)
    if (ts.isTemplateExpression(node)) {
      // Check if this template contains any opaque refs
      const opaqueRoots = collectOpaqueRootsInTemplate(node, config);

      if (opaqueRoots.size > 0) {
        // This template uses opaque refs - wrap with str tag
        const strExpr = context.ctHelpers.getHelperExpr("str");

        // First, recursively transform any nested templates in the spans
        const transformedSpans = node.templateSpans.map((span) => {
          const transformedExpr = ts.visitNode(
            span.expression,
            transformTemplateLiterals,
          ) as ts.Expression;
          return factory.createTemplateSpan(
            transformedExpr,
            span.literal,
          );
        });

        const transformedTemplate = factory.createTemplateExpression(
          node.head,
          transformedSpans,
        );

        return factory.createTaggedTemplateExpression(
          strExpr,
          undefined, // type arguments
          transformedTemplate,
        );
      }
    }

    // Handle TaggedTemplateExpression - don't double-tag
    if (ts.isTaggedTemplateExpression(node)) {
      // Already tagged, just recurse into the template if needed
      if (ts.isTemplateExpression(node.template)) {
        const transformedSpans = node.template.templateSpans.map((span) => {
          const transformedExpr = ts.visitNode(
            span.expression,
            transformTemplateLiterals,
          ) as ts.Expression;
          return factory.createTemplateSpan(
            transformedExpr,
            span.literal,
          );
        });

        const transformedTemplate = factory.createTemplateExpression(
          node.template.head,
          transformedSpans,
        );

        return factory.createTaggedTemplateExpression(
          node.tag,
          node.typeArguments,
          transformedTemplate,
        );
      }
      return node;
    }

    // Recurse into children
    return ts.visitEachChild(node, transformTemplateLiterals, context.tsContext);
  };

  // Transform the body
  if (ts.isBlock(body)) {
    const transformedStatements = body.statements.map((stmt) =>
      ts.visitNode(stmt, transformTemplateLiterals) as ts.Statement
    );
    return factory.createBlock(transformedStatements, true);
  } else {
    // Concise body (expression)
    return ts.visitNode(body, transformTemplateLiterals) as ts.Expression;
  }
}

/**
 * Information about an opaque expression found in a template.
 */
interface OpaqueExpressionInfo {
  /** The original expression (e.g., state.greeting, item.name) */
  readonly expression: ts.Expression;
  /** Generated unique binding name for this expression */
  readonly bindingName: string;
  /** String representation of the expression for comparison */
  readonly key: string;
}

/**
 * Convert an expression to a string key for deduplication.
 */
function expressionToKey(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return `${expressionToKey(expr.expression)}.${expr.name.text}`;
  }
  if (ts.isElementAccessExpression(expr)) {
    if (ts.isStringLiteral(expr.argumentExpression)) {
      return `${expressionToKey(expr.expression)}[${expr.argumentExpression.text}]`;
    }
    // For dynamic element access, use a placeholder
    return `${expressionToKey(expr.expression)}[?]`;
  }
  return "?";
}

/**
 * Generate a safe binding name from an expression.
 * E.g., state.greeting -> state_greeting, item.name -> item_name
 */
function generateBindingName(expr: ts.Expression, usedNames: Set<string>): string {
  const key = expressionToKey(expr);
  // Replace dots and brackets with underscores
  let baseName = key.replace(/\./g, "_").replace(/\[/g, "_").replace(/\]/g, "").replace(/\?/g, "x");

  // Ensure it's a valid identifier
  if (!/^[a-zA-Z_$]/.test(baseName)) {
    baseName = "_" + baseName;
  }

  // Make unique if needed
  let name = baseName;
  let counter = 1;
  while (usedNames.has(name)) {
    name = `${baseName}_${counter}`;
    counter++;
  }
  usedNames.add(name);
  return name;
}

/**
 * Collect ROOT opaque identifiers used in a template expression.
 * For property accesses like `state.prefix` or `item.name`, we collect the ROOT
 * identifier (`state` or `item`), not the full path.
 *
 * This is because captures are stored in hierarchical params objects, and we need
 * to pass the root object to derive and access properties inside the callback.
 */
function collectOpaqueRootsInTemplate(
  template: ts.TemplateExpression,
  config: TemplateLiteralWrapConfig,
): Set<string> {
  const roots = new Set<string>();

  const collectFromExpression = (expr: ts.Expression): void => {
    // For property accesses, check if the root is opaque
    if (
      ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)
    ) {
      const rootName = getRootIdentifierName(expr);
      if (rootName && isOpaqueRoot(rootName, config)) {
        // Collect just the ROOT name
        roots.add(rootName);
        return;
      }
      // Not an opaque root, recurse
      if (ts.isPropertyAccessExpression(expr)) {
        collectFromExpression(expr.expression);
      } else {
        collectFromExpression(expr.expression);
        collectFromExpression(expr.argumentExpression);
      }
      return;
    }

    // For standalone identifiers that are opaque roots
    if (ts.isIdentifier(expr)) {
      if (isOpaqueRoot(expr.text, config)) {
        roots.add(expr.text);
      }
      return;
    }

    // For call expressions, check arguments
    if (ts.isCallExpression(expr)) {
      collectFromExpression(expr.expression);
      expr.arguments.forEach(collectFromExpression);
      return;
    }

    // For binary expressions
    if (ts.isBinaryExpression(expr)) {
      collectFromExpression(expr.left);
      collectFromExpression(expr.right);
      return;
    }

    // For conditional expressions
    if (ts.isConditionalExpression(expr)) {
      collectFromExpression(expr.condition);
      collectFromExpression(expr.whenTrue);
      collectFromExpression(expr.whenFalse);
      return;
    }

    // For parenthesized expressions
    if (ts.isParenthesizedExpression(expr)) {
      collectFromExpression(expr.expression);
      return;
    }
  };

  // Collect from each template span
  for (const span of template.templateSpans) {
    collectFromExpression(span.expression);
  }

  return roots;
}

/**
 * Get the root identifier name of a property/element access chain.
 * E.g., for `state.config.value`, returns "state"
 */
function getRootIdentifierName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return getRootIdentifierName(expr.expression);
  }
  if (ts.isElementAccessExpression(expr)) {
    return getRootIdentifierName(expr.expression);
  }
  return undefined;
}

/**
 * Check if an identifier name is an opaque root (from captures or element).
 */
function isOpaqueRoot(
  name: string,
  config: TemplateLiteralWrapConfig,
): boolean {
  return config.captureRoots.has(name) || name === config.elementName;
}
