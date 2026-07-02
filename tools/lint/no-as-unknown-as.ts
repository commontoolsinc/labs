/// <reference lib="deno.unstable" />

import { noAsUnknownAsBaseline } from "./no-as-unknown-as-baseline.ts";

interface LintContext {
  readonly filename: string;
  readonly sourceCode: {
    readonly text: string;
  };
  report(report: Deno.lint.ReportData): void;
}

interface TypeAnnotation {
  readonly type?: string;
  readonly range?: readonly [number, number];
}

interface TSAsExpressionNode {
  readonly type?: string;
  readonly range?: readonly [number, number];
  readonly expression?: {
    readonly type?: string;
    readonly range?: readonly [number, number];
    readonly typeAnnotation?: TypeAnnotation;
  };
  readonly typeAnnotation?: TypeAnnotation;
}

export interface NoAsUnknownAsBaseline {
  consume(file: string, fingerprint: string): boolean;
}

const repoRootPath = normalizePath(
  decodeURIComponent(new URL("../..", import.meta.url).pathname),
);
const doubleAssertionRangePattern = /\bas\s+unknown\s+as\b/;

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function relativeFilename(filename: string): string {
  const normalized = normalizePath(filename);
  if (normalized.startsWith(`${repoRootPath}/`)) {
    return normalized.slice(repoRootPath.length + 1);
  }
  return normalized;
}

function lineStartsFor(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineColumnForOffset(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: offset - lineStarts[lineIndex],
  };
}

function fingerprintForText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isDoubleAssertionThroughUnknown(node: TSAsExpressionNode): boolean {
  return node.type === "TSAsExpression" &&
    node.expression?.type === "TSAsExpression" &&
    node.expression.typeAnnotation?.type === "TSUnknownKeyword";
}

export function baselineKeyForNode(
  context: LintContext,
  node: TSAsExpressionNode,
):
  | { file: string; line: number; column: number; fingerprint: string }
  | undefined {
  const range = reportRangeForNode(context.sourceCode.text, node);
  const start = range?.[0];
  if (start === undefined) return undefined;
  const nodeRange = node.range;
  if (!nodeRange) return undefined;
  const lineStarts = lineStartsFor(context.sourceCode.text);
  return {
    file: relativeFilename(context.filename),
    ...lineColumnForOffset(lineStarts, start),
    fingerprint: fingerprintForText(
      context.sourceCode.text.slice(nodeRange[0], nodeRange[1]),
    ),
  };
}

function reportRangeForNode(
  sourceText: string,
  node: TSAsExpressionNode,
): [number, number] | undefined {
  const range = node.range;
  if (!range) return undefined;

  const unknownRange = node.expression?.typeAnnotation?.range;
  if (unknownRange) {
    const expressionStart = node.expression?.range?.[0] ?? range[0];
    const beforeUnknown = sourceText.slice(expressionStart, unknownRange[0]);
    const unknownAsMatch = /\bas\s*$/.exec(beforeUnknown);
    const start = unknownAsMatch
      ? expressionStart + unknownAsMatch.index
      : unknownRange[0];

    const afterUnknownEnd = node.typeAnnotation?.range?.[0] ?? range[1];
    const afterUnknown = sourceText.slice(unknownRange[1], afterUnknownEnd);
    const outerAsMatch = /^\s+as\b/.exec(afterUnknown);
    const end = outerAsMatch
      ? unknownRange[1] + outerAsMatch[0].length
      : unknownRange[1];

    return [start, end];
  }

  const text = sourceText.slice(range[0], range[1]);
  const match = doubleAssertionRangePattern.exec(text);
  if (!match) return [range[0], range[1]];
  return [range[0] + match.index, range[0] + match.index + match[0].length];
}

export function createNoAsUnknownAsRule(
  context: LintContext,
  baseline: NoAsUnknownAsBaseline = noAsUnknownAsBaseline,
) {
  const file = relativeFilename(context.filename);

  return {
    TSAsExpression(node: unknown) {
      const asNode = node as TSAsExpressionNode;
      if (!isDoubleAssertionThroughUnknown(asNode)) return;

      const reportRange = reportRangeForNode(context.sourceCode.text, asNode);
      const start = reportRange?.[0];
      if (start === undefined) return;

      const nodeRange = asNode.range;
      if (!nodeRange) return;

      const fingerprint = fingerprintForText(
        context.sourceCode.text.slice(nodeRange[0], nodeRange[1]),
      );
      if (baseline.consume(file, fingerprint)) return;

      context.report({
        range: reportRange,
        message:
          "Do not cast a value through unknown before casting it to another type. Add a narrower helper, runtime validation, or a local type that matches the value.",
      });
    },
  };
}

export default {
  name: "cf",
  rules: {
    "no-as-unknown-as": {
      create(context) {
        return createNoAsUnknownAsRule(context as LintContext);
      },
    },
  },
} satisfies Deno.lint.Plugin;
