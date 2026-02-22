import { assert } from "@std/assert";
import {
  debugVDOMSchema,
  rendererVDOMSchema,
  vnodeSchema,
} from "../src/schemas.ts";

const hasUndefinedType = (schema: unknown): boolean => {
  return !!(
    schema &&
    typeof schema === "object" &&
    "type" in schema &&
    (schema as { type: unknown }).type === "undefined"
  );
};

const anyOfIncludesUndefined = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object" || !("anyOf" in schema)) {
    return false;
  }
  const anyOf = (schema as { anyOf: unknown[] }).anyOf;
  return Array.isArray(anyOf) && anyOf.some((entry) => hasUndefinedType(entry));
};

Deno.test("rendererVDOMSchema allows undefined child entries", () => {
  const vdomNode = (rendererVDOMSchema.$defs as Record<string, unknown>)
    .vdomNode as {
      properties: Record<string, unknown>;
    };

  const childArraySchema = vdomNode.properties.children as { items: unknown };
  assert(
    anyOfIncludesUndefined(childArraySchema.items),
    "rendererVDOMSchema.children items should include type=undefined",
  );
});

Deno.test("debugVDOMSchema allows undefined child entries", () => {
  const vdomNode = (debugVDOMSchema.$defs as Record<string, unknown>)
    .vdomNode as {
      properties: Record<string, unknown>;
    };

  const childArraySchema = vdomNode.properties.children as { items: unknown };
  assert(
    anyOfIncludesUndefined(childArraySchema.items),
    "debugVDOMSchema.children items should include type=undefined",
  );
});

Deno.test("vnodeSchema allows undefined in render-node and prop-value unions", () => {
  const defs = vnodeSchema.$defs as Record<string, unknown>;
  const renderNodeSchema = defs.RenderNode;
  const propsSchema = defs.Props as {
    additionalProperties: unknown;
  };

  assert(
    anyOfIncludesUndefined(renderNodeSchema),
    "vnodeSchema RenderNode should include type=undefined",
  );
  assert(
    anyOfIncludesUndefined(propsSchema.additionalProperties),
    "vnodeSchema Props additionalProperties should include type=undefined",
  );
});
