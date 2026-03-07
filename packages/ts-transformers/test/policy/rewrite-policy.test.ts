import ts from "typescript";
import { assertEquals } from "@std/assert";
import {
  shouldLowerLogicalInJsx,
  shouldRewriteCollectionMethod,
} from "../../src/policy/mod.ts";

Deno.test("Rewrite policy: JSX logical lowering matrix", () => {
  assertEquals(
    shouldLowerLogicalInJsx("pattern", ts.SyntaxKind.AmpersandAmpersandToken),
    true,
  );
  assertEquals(
    shouldLowerLogicalInJsx("pattern", ts.SyntaxKind.BarBarToken),
    true,
  );
  assertEquals(
    shouldLowerLogicalInJsx("compute", ts.SyntaxKind.AmpersandAmpersandToken),
    false,
  );
  assertEquals(
    shouldLowerLogicalInJsx("compute", ts.SyntaxKind.BarBarToken),
    false,
  );
  assertEquals(
    shouldLowerLogicalInJsx("neutral", ts.SyntaxKind.AmpersandAmpersandToken),
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
    shouldRewriteCollectionMethod("pattern", "map", "reactive"),
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
    shouldRewriteCollectionMethod("compute", "map", "reactive"),
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
  assertEquals(
    shouldRewriteCollectionMethod(
      "pattern",
      "filter",
      "celllike_requires_rewrite",
    ),
    false,
  );
});
