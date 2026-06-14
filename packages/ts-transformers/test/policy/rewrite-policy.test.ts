import ts from "typescript";
import { assertEquals } from "@std/assert";
import {
  shouldLowerLogicalExpression,
  shouldRewriteCollectionMethod,
} from "../../src/policy/mod.ts";

Deno.test("Rewrite policy: JSX logical lowering matrix", () => {
  assertEquals(
    shouldLowerLogicalExpression(
      "pattern",
      "jsx-expression",
      ts.SyntaxKind.AmpersandAmpersandToken,
    ),
    true,
  );
  assertEquals(
    shouldLowerLogicalExpression(
      "pattern",
      "call-argument",
      ts.SyntaxKind.BarBarToken,
    ),
    true,
  );
  assertEquals(
    shouldLowerLogicalExpression(
      "compute",
      "jsx-expression",
      ts.SyntaxKind.AmpersandAmpersandToken,
    ),
    false,
  );
  assertEquals(
    shouldLowerLogicalExpression(
      "compute",
      "object-property",
      ts.SyntaxKind.BarBarToken,
    ),
    false,
  );
  assertEquals(
    shouldLowerLogicalExpression(
      "neutral",
      "jsx-expression",
      ts.SyntaxKind.AmpersandAmpersandToken,
    ),
    false,
  );
});

Deno.test("Rewrite policy: map rewrite matrix", () => {
  // Pattern context rewrites all reactive receiver kinds except plain arrays.
  assertEquals(
    shouldRewriteCollectionMethod("pattern", "map", "plain"),
    false,
  );
  assertEquals(
    shouldRewriteCollectionMethod("pattern", "map", "opaque_autounwrapped"),
    true,
  );
  assertEquals(
    shouldRewriteCollectionMethod(
      "pattern",
      "map",
      "celllike_requires_rewrite",
    ),
    true,
  );

  // Compute context rewrites only cell-like receivers.
  assertEquals(
    shouldRewriteCollectionMethod("compute", "map", "plain"),
    false,
  );
  assertEquals(
    shouldRewriteCollectionMethod("compute", "map", "opaque_autounwrapped"),
    false,
  );
  assertEquals(
    shouldRewriteCollectionMethod(
      "compute",
      "map",
      "celllike_requires_rewrite",
    ),
    true,
  );

  // Neutral context never rewrites.
  assertEquals(
    shouldRewriteCollectionMethod(
      "neutral",
      "map",
      "celllike_requires_rewrite",
    ),
    false,
  );
  // filter and flatMap follow the same rewrite policy as map.
  assertEquals(
    shouldRewriteCollectionMethod(
      "pattern",
      "filter",
      "celllike_requires_rewrite",
    ),
    true,
  );
  assertEquals(
    shouldRewriteCollectionMethod(
      "pattern",
      "flatMap",
      "celllike_requires_rewrite",
    ),
    true,
  );
  assertEquals(
    shouldRewriteCollectionMethod(
      "pattern",
      "filter",
      "plain",
    ),
    false,
  );
  assertEquals(
    shouldRewriteCollectionMethod(
      "compute",
      "filter",
      "opaque_autounwrapped",
    ),
    false,
  );
  assertEquals(
    shouldRewriteCollectionMethod(
      "neutral",
      "flatMap",
      "celllike_requires_rewrite",
    ),
    false,
  );
});
