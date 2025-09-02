import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";

export class IntersectionFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: { generateSchema: Function }) {}

  supportsType(type: ts.Type): boolean {
    return (type.flags & ts.TypeFlags.Intersection) !== 0;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    const checker = context.typeChecker;
    const inter = type as ts.IntersectionType;
    const parts = inter.types ?? [] as ts.Type[];

    // Validate constituents similar to legacy behavior
    const failureReasons: string[] = [];
    const isObjectLike = (t: ts.Type) => (t.flags & ts.TypeFlags.Object) !== 0;

    for (const t of parts) {
      if (!isObjectLike(t)) {
        failureReasons.push("non-object constituent");
        break;
      }
      try {
        const stringIndex = checker.getIndexTypeOfType(t, ts.IndexKind.String);
        const numberIndex = checker.getIndexTypeOfType(t, ts.IndexKind.Number);
        if (stringIndex || numberIndex) {
          failureReasons.push("index signature on constituent");
          break;
        }
        const callSigs = checker.getSignaturesOfType(t, ts.SignatureKind.Call);
        const constructSigs = checker.getSignaturesOfType(
          t,
          ts.SignatureKind.Construct,
        );
        if (callSigs.length > 0 || constructSigs.length > 0) {
          failureReasons.push("call/construct signatures on constituent");
          break;
        }
      } catch (_e) {
        failureReasons.push("checker error while validating intersection");
        break;
      }
    }

    if (failureReasons.length > 0) {
      return {
        type: "object",
        additionalProperties: true,
        $comment: `Unsupported intersection pattern: ${failureReasons[0]}`,
      } as SchemaDefinition;
    }

    // Merge object-like constituents: combine properties and required
    if (this.schemaGenerator) {
      const mergedProps: Record<string, SchemaDefinition> = {};
      const requiredSet: Set<string> = new Set();

      for (const part of parts) {
        const schema = (this.schemaGenerator as any).generateSchema(
          part,
          checker,
        ) as any;
        if (schema && typeof schema === "object") {
          if (schema.properties && typeof schema.properties === "object") {
            for (const [k, v] of Object.entries(schema.properties)) {
              mergedProps[k] = v as SchemaDefinition;
            }
          }
          if (Array.isArray(schema.required)) {
            for (const r of schema.required) requiredSet.add(r);
          }
        }
      }

      const out: any = { type: "object", properties: mergedProps };
      if (requiredSet.size > 0) out.required = Array.from(requiredSet);
      return out as SchemaDefinition;
    }

    // Fallback: allOf
    const allOf = parts.map((p) => ({
      type: "object",
      additionalProperties: true,
    }));
    return { allOf } as unknown as SchemaDefinition;
  }
}
