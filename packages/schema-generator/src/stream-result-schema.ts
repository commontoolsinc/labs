import ts from "typescript";
import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import type { GenerationContext } from "./interface.ts";
import type { SchemaGenerator } from "./schema-generator.ts";

/**
 * The schema of a verb's declared result, emitted under the `result` dialect
 * keyword on the stream property's schema — sibling to `asCell: ["stream"]`,
 * produced by the same type check that emits the marker. The schema object
 * itself stays the EVENT schema a caller sends; the two travel together by
 * construction, so there is no state where the marker lands and the result
 * schema does not.
 *
 * A value-less verb (`Stream<E>` / `Stream<E, void>`) emits
 * `{ type: "object", properties: {} }`, NOT the generic `void` sentinel: the
 * sentinel lowers to `{ asCell: ["opaque"] }` — a *wrapper* claim that would
 * hand readback a cell to resolve — while the empty object describes the `{}`
 * receipt the runtime actually writes. `additionalProperties` stays undefined
 * (open): the compat checker reads `additionalProperties ?? true`, and
 * emitting `false` would freeze a verb as value-less forever. A declared
 * result is likewise left open — nothing is closed beyond what the result
 * type itself demands.
 */
export function streamResultSchema(
  resultType: ts.Type | undefined,
  resultTypeNode: ts.TypeNode | undefined,
  context: GenerationContext,
  schemaGenerator: SchemaGenerator,
): MutableJSONSchema {
  let resolved = resultType;
  if (resolved === undefined && resultTypeNode !== undefined) {
    try {
      resolved = context.typeRegistry?.get(resultTypeNode) ??
        context.typeChecker.getTypeFromTypeNode(resultTypeNode);
    } catch {
      resolved = context.typeChecker.getAnyType();
    }
  }
  if (resolved === undefined || (resolved.flags & ts.TypeFlags.Void) !== 0) {
    return valueLessResultSchema();
  }
  return schemaGenerator.formatChildType(resolved, context, resultTypeNode);
}

/** The `{}` receipt schema of a verb that declares no result. */
export function valueLessResultSchema(): MutableJSONSchemaObj {
  return { type: "object", properties: {} };
}
