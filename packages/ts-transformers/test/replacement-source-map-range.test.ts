/**
 * Verifies authored source-map ranges on synthesized replacements outside the
 * builder-artifact path.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import { recoverAuthoredPosition } from "../src/ast/mod.ts";
import {
  CFC_TRANSFORMER_STAGE_NAMES,
  CommonFabricTransformerPipeline,
} from "../src/cf-pipeline.ts";
import { TransformationContext } from "../src/core/mod.ts";
import { createReactiveWrapperForExpression } from "../src/transformers/expression-rewrite/rewrite-helpers.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { batchTypeCheckFixtures } from "./utils.ts";

const ROUTER_FIXTURE = `import {
  Default,
  pattern,
  UI,
  UiAction,
  UiPromptSlot,
} from "commonfabric";

interface Input {
  visible: boolean | Default<false>;
  count: number | Default<0>;
}

export default pattern<Input>((state) => ({
  [UI]: (
    <div>
      <UiAction action="CT1869_UI">run</UiAction>
      <UiPromptSlot surface="CT1869_SURFACE" role="composer" />
      <span>
        {state.visible
          ? (() => {
            const message = state.count + " CT1869_PRE";
            return <b>{message}</b>;
          })()
          : <i>hidden</i>}
      </span>
    </div>
  ),
}));
`;

const OWNED_ROUTER_FIXTURE = `import {
  ifElse,
  pattern,
  UI,
} from "commonfabric";

interface Input {
  visible: boolean;
  count: number;
}

export default pattern<Input>((state) => ({
  [UI]: <span>{ifElse(state.visible, state.count + 1869, 0)}</span>,
}));
`;

const CLOSURE_FIXTURE = `import {
  Default,
  pattern,
  UI,
} from "commonfabric";

interface Input {
  count: number | Default<0>;
  groups: {
    rows: Array<{ title: string }>;
  };
}

export default pattern<Input>((state) => ({
  [UI]: (
    <div>
      <button onClick={() => state.count + 1869}>run</button>
      <ul>
        {state.groups.rows.map((row) => (
          <li>{row.title === "x" ? "CT1869_MAP" : row.title}</li>
        ))}
      </ul>
    </div>
  ),
}));
`;

const POST_CLOSURE_FIXTURE = `import {
  pattern,
  UI,
} from "commonfabric";

interface Input {
  items: Array<{ ct1869Active: boolean }>;
}

export default pattern<Input>((state) => ({
  [UI]: (
    <span>
      {state.items.filter((item) => item.ct1869Active).length > 0}
    </span>
  ),
}));
`;

const ZERO_INPUT_FIXTURE = `import {
  Default,
  pattern,
} from "commonfabric";

interface Input {
  items: string[] | Default<[]>;
  index: number | Default<0>;
}

export default pattern<Input>((state) => {
  const picked = state.items[state.index] + "CT1869_ZERO";
  return { picked };
});
`;

const PATTERN_BODY_FIXTURE = `import {
  pattern,
} from "commonfabric";

interface Input {
  profile: { label: string };
}

export default pattern<Input>((state) => {
  const label = state.profile.label;
  return { label };
});
`;

const MODULE_DATA_FIXTURE = `import {
  pattern,
} from "commonfabric";

const DATA = { marker: "CT1869_DATA" };

export default pattern(() => ({ DATA }));
`;

interface StageTransformResult {
  readonly original: ts.SourceFile;
  readonly transformed: ts.SourceFile;
}

/** Runs a fixture through the named stage while preserving emit-node data. */
async function transformThroughStage(
  source: string,
  fileName: string,
  stageName: string,
): Promise<StageTransformResult> {
  const { program } = await batchTypeCheckFixtures(
    { [fileName]: source },
    { types: COMMONFABRIC_TYPES },
  );
  const original = program.getSourceFile(fileName);
  assert(original, `fixture source file present: ${fileName}`);

  const stageIndex = CFC_TRANSFORMER_STAGE_NAMES.indexOf(stageName);
  assert(stageIndex >= 0, `transformer stage present: ${stageName}`);

  const pipeline = new CommonFabricTransformerPipeline();
  const factories = pipeline.toFactories(program).slice(0, stageIndex + 1);
  const result = ts.transform(original, factories);
  const transformed = result.transformed[0];
  assert(transformed, `stage returned a transformed source file: ${stageName}`);

  // Disposing the result can clear emit-node data that stores sourceMapRange.
  return { original, transformed };
}

/** Collects every node in a tree that satisfies the supplied type guard. */
function collectNodes<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

/** Returns whether a subtree contains a node satisfying the predicate. */
function subtreeContains(
  root: ts.Node,
  predicate: (node: ts.Node) => boolean,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Selects the only node matching a structural predicate. */
function findOnly<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
  label: string,
): T {
  const matches = collectNodes(root, predicate);
  expect(matches, label).toHaveLength(1);
  return matches[0]!;
}

/** Asserts that a replacement resolves to the expected authored source. */
function expectAuthoredText(
  node: ts.Node,
  original: ts.SourceFile,
  expected: string,
): void {
  assert(node.pos < 0, `expected a synthesized replacement for ${expected}`);
  const position = recoverAuthoredPosition(node);
  assert(position, `expected authored position for ${expected}`);
  expect(original.text.slice(position.pos, position.end)).toContain(expected);
}

function hasString(root: ts.Node, text: string): boolean {
  return subtreeContains(
    root,
    (node) => ts.isStringLiteral(node) && node.text === text,
  );
}

function hasIdentifier(root: ts.Node, text: string): boolean {
  return subtreeContains(
    root,
    (node) => ts.isIdentifier(node) && node.text === text,
  );
}

describe("replacement source-map ranges", () => {
  it("preserves authored positions on JSX-router replacements", async () => {
    const { original, transformed } = await transformThroughStage(
      ROUTER_FIXTURE,
      "/ct1869-router.tsx",
      "JsxExpressionSiteRouterTransformer",
    );

    const uiHelper = findOnly(
      transformed,
      (node): node is ts.JsxElement =>
        ts.isJsxElement(node) &&
        ts.isIdentifier(node.openingElement.tagName) &&
        node.openingElement.tagName.text === "ct-button",
      "rewritten UiAction",
    );
    expectAuthoredText(uiHelper, original, "<UiAction");

    const selfClosingUiHelper = findOnly(
      transformed,
      (node): node is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(node) &&
        ts.isIdentifier(node.tagName) && node.tagName.text === "ct-textarea",
      "rewritten self-closing UiPromptSlot",
    );
    expectAuthoredText(selfClosingUiHelper, original, "<UiPromptSlot");

    const sharedPre = findOnly(
      transformed,
      (node): node is ts.JsxExpression =>
        ts.isJsxExpression(node) && hasString(node, " CT1869_PRE"),
      "shared pre-closure JSX expression",
    );
    expectAuthoredText(
      sharedPre,
      original,
      "state.visible",
    );

    const ownedResult = await transformThroughStage(
      OWNED_ROUTER_FIXTURE,
      "/ct1869-owned-router.tsx",
      "JsxExpressionSiteRouterTransformer",
    );
    const owned = findOnly(
      ownedResult.transformed,
      (node): node is ts.JsxExpression =>
        ts.isJsxExpression(node) &&
        subtreeContains(
          node,
          (child) => ts.isNumericLiteral(child) && child.text === "1869",
        ),
      "owned pre-closure JSX expression",
    );
    expectAuthoredText(
      owned,
      ownedResult.original,
      "ifElse(state.visible, state.count + 1869, 0)",
    );
  });

  it("preserves authored positions on closure replacements", async () => {
    const { original, transformed } = await transformThroughStage(
      CLOSURE_FIXTURE,
      "/ct1869-closure.tsx",
      "ClosureTransformer",
    );

    const handler = findOnly(
      transformed,
      (node): node is ts.JsxAttribute =>
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) && node.name.text === "onClick" &&
        subtreeContains(
          node,
          (child) => ts.isNumericLiteral(child) && child.text === "1869",
        ),
      "rewritten handler attribute",
    );
    expectAuthoredText(
      handler,
      original,
      "onClick={() => state.count + 1869}",
    );
    assert(handler.initializer && ts.isJsxExpression(handler.initializer));
    expectAuthoredText(
      handler.initializer,
      original,
      "{() => state.count + 1869}",
    );

    const receiverKey = findOnly(
      transformed,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "key" &&
        hasString(node, "groups") && hasString(node, "rows"),
      "lowered array-method receiver",
    );
    expectAuthoredText(receiverKey, original, "state.groups.rows");

    const callbackExpression = findOnly(
      transformed,
      (node): node is ts.JsxExpression =>
        ts.isJsxExpression(node) && hasString(node, "CT1869_MAP") &&
        !!node.expression &&
        !subtreeContains(node.expression, ts.isJsxExpression),
      "rewritten array-callback JSX expression",
    );
    expectAuthoredText(
      callbackExpression,
      original,
      '{row.title === "x" ? "CT1869_MAP" : row.title}',
    );
  });

  it("preserves authored positions on post-closure JSX containers", async () => {
    const { original, transformed } = await transformThroughStage(
      POST_CLOSURE_FIXTURE,
      "/ct1869-post-closure.tsx",
      "PatternOwnedExpressionSiteLoweringTransformer",
    );

    const replacement = findOnly(
      transformed,
      (node): node is ts.JsxExpression =>
        ts.isJsxExpression(node) && hasIdentifier(node, "ct1869Active") &&
        subtreeContains(
          node,
          (child) =>
            ts.isBinaryExpression(child) &&
            child.operatorToken.kind === ts.SyntaxKind.GreaterThanToken,
        ),
      "post-closure JSX expression",
    );
    expectAuthoredText(
      replacement,
      original,
      "state.items.filter((item) => item.ct1869Active).length > 0",
    );
  });

  it("preserves the authored branch on zero-input wrappers", async () => {
    const fileName = "/ct1869-zero-input.tsx";
    const { program } = await batchTypeCheckFixtures(
      { [fileName]: ZERO_INPUT_FIXTURE },
      { types: COMMONFABRIC_TYPES },
    );
    const original = program.getSourceFile(fileName);
    assert(original, "zero-input fixture source file present");

    let rewritten: ts.Expression | undefined;
    const result = ts.transform(original, [
      (tsContext) => (sourceFile) => {
        const context = new TransformationContext({
          program,
          sourceFile,
          tsContext,
        });
        const expression = findOnly(
          sourceFile,
          (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) && hasString(node, "CT1869_ZERO"),
          "dynamic pattern-body initializer",
        );
        const analysis = context.getDataFlowAnalyzer()(expression);
        rewritten = createReactiveWrapperForExpression(
          expression,
          context.getRelevantDataFlowsFromAnalysis(analysis),
          context,
        );
        return sourceFile;
      },
    ]);
    assert(result.transformed[0], "zero-input probe transform completed");
    assert(rewritten, "zero-input reactive wrapper created");

    const wrapper = findOnly(
      rewritten,
      (node): node is ts.ArrowFunction =>
        ts.isArrowFunction(node) && node.parameters.length === 0 &&
        hasString(node, "CT1869_ZERO"),
      "zero-input reactive wrapper",
    );
    expectAuthoredText(
      wrapper,
      original,
      'state.items[state.index] + "CT1869_ZERO"',
    );
  });

  it("preserves authored positions on pattern-body replacements", async () => {
    const { original, transformed } = await transformThroughStage(
      PATTERN_BODY_FIXTURE,
      "/ct1869-pattern-body.tsx",
      "PatternCallbackLoweringTransformer",
    );

    const replacement = findOnly(
      transformed,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "key" &&
        hasString(node, "profile") && hasString(node, "label"),
      "pattern-body property replacement",
    );
    expectAuthoredText(replacement, original, "state.profile.label");
  });

  it("preserves authored positions on module-scope data wrappers", async () => {
    const { original, transformed } = await transformThroughStage(
      MODULE_DATA_FIXTURE,
      "/ct1869-module-data.tsx",
      "ModuleScopeCfDataTransformer",
    );

    const replacement = findOnly(
      transformed,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "__cf_data" &&
        hasString(node, "CT1869_DATA"),
      "module-scope data wrapper",
    );
    expectAuthoredText(
      replacement,
      original,
      '{ marker: "CT1869_DATA" }',
    );
  });
});
