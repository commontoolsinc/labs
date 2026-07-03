/// <reference lib="deno.unstable" />

import { NO_AS_ANY_ALLOWLIST } from "./no-as-any-allowlist.ts";

interface LintContext {
  readonly filename: string;
  report(report: { node: unknown; message: string }): void;
}

interface LintNode {
  readonly type: string;
}

interface TsAsExpression extends LintNode {
  readonly type: "TSAsExpression";
  readonly typeAnnotation: unknown;
}

interface TsTypeAssertion extends LintNode {
  readonly type: "TSTypeAssertion";
  readonly typeAnnotation: unknown;
}

const repoRoot = decodeURIComponent(new URL("..", import.meta.url).pathname)
  .replaceAll("\\", "/")
  .replace(/\/$/, "");

function relativePath(filename: string): string {
  let path = filename.replaceAll("\\", "/");
  if (path.startsWith("file://")) {
    path = decodeURIComponent(new URL(path).pathname);
  }
  if (path.startsWith(`${repoRoot}/`)) {
    path = path.slice(repoRoot.length + 1);
  }
  return path.replace(/^\.\//, "");
}

interface AstObject {
  readonly type?: unknown;
  readonly [key: string]: unknown;
}

const AST_CHILD_KEYS = [
  "argument",
  "arguments",
  "checkType",
  "constraint",
  "default",
  "elementType",
  "elementTypes",
  "extendsType",
  "falseType",
  "indexType",
  "key",
  "members",
  "nameType",
  "objectType",
  "parameterName",
  "parameters",
  "params",
  "qualifier",
  "returnType",
  "trueType",
  "typeAnnotation",
  "typeArguments",
  "typeParameter",
  "typeParameters",
  "typeName",
  "types",
] as const;

function containsAnyType(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsAnyType(item, seen));
  }

  const node = value as AstObject;
  if (node.type === "TSAnyKeyword") {
    return true;
  }

  return AST_CHILD_KEYS.some((key) => containsAnyType(node[key], seen));
}

export function createNoAsAnyRule(
  allowlistEntries = NO_AS_ANY_ALLOWLIST,
) {
  const allowlist = new Set(allowlistEntries);

  function visitTypeAssertion(
    context: LintContext,
    node: TsAsExpression | TsTypeAssertion,
  ) {
    if (allowlist.has(relativePath(context.filename))) {
      return;
    }

    if (!containsAnyType(node.typeAnnotation)) {
      return;
    }

    context.report({
      node,
      message:
        "Type assertions to `any` hide type errors. Use a narrower type, a type guard, or a typed helper.",
    });
  }

  return {
    create(context: unknown) {
      const localContext = context as unknown as LintContext;
      return {
        TSAsExpression(node: unknown) {
          visitTypeAssertion(localContext, node as unknown as TsAsExpression);
        },
        TSTypeAssertion(node: unknown) {
          visitTypeAssertion(localContext, node as unknown as TsTypeAssertion);
        },
      };
    },
  };
}

export default {
  name: "cf-no-as-any",
  rules: {
    "no-as-any": createNoAsAnyRule(),
  },
} satisfies Deno.lint.Plugin;
