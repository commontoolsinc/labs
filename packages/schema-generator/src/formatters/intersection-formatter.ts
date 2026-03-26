import ts from "typescript";
import type {
  JSONSchemaMutable,
  JSONSchemaMutableOrBoolean,
} from "@commontools/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { cloneSchemaDefinition, getNativeTypeSchema } from "../type-utils.ts";
import { getLogger } from "@commontools/utils/logger";
import { isRecord } from "@commontools/utils/types";
import { extractDocFromType } from "../doc-utils.ts";
import { isCellType } from "../typescript/cell-brand.ts";

const logger = getLogger("schema-generator.intersection");
const DOC_CONFLICT_COMMENT =
  "Conflicting docs across intersection constituents; using first";

export class IntersectionFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    // Don't handle cell types - they are intersection types but should be handled by CommonToolsFormatter
    if (isCellType(type, context.typeChecker)) {
      return false;
    }
    return (type.flags & ts.TypeFlags.Intersection) !== 0;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): JSONSchemaMutableOrBoolean {
    const checker = context.typeChecker;
    const native = getNativeTypeSchema(type, checker);
    if (native !== undefined) {
      return cloneSchemaDefinition(native);
    }
    const inter = type as ts.IntersectionType;
    const parts = inter.types ?? [];

    if (parts.length === 0) {
      throw new Error(
        "IntersectionFormatter received empty intersection type",
      );
    }

    // Filter out "brand-only" and empty object parts before validation.
    // These arise from:
    //   1. RequireDefaults<T> applied to non-Default types (e.g. number[] & {})
    //   2. Default<T,V> brand constituents in a union (e.g. boolean & { [DEFAULT_MARKER]: T })
    // Brand-only parts are object types with no string-keyed properties and no
    // index signatures — they carry only symbol-keyed brand markers.
    const effectiveParts = parts.filter(
      (p) => !this.isBrandOnlyOrEmpty(p, checker),
    );

    // If all parts were brand markers / empty, fall back to the full set
    // (shouldn't happen in practice, but be defensive).
    const partsToProcess = effectiveParts.length > 0 ? effectiveParts : parts;

    // If filtering reduced us to a single substantive part, delegate directly.
    if (partsToProcess.length === 1) {
      return this.schemaGenerator.formatChildType(partsToProcess[0]!, context);
    }

    const failureReason = this.validateIntersectionParts(
      partsToProcess,
      checker,
    );
    if (failureReason) {
      return {
        type: "object",
        additionalProperties: true,
        $comment: `Unsupported intersection pattern: ${failureReason}`,
      };
    }

    const merged = this.mergeIntersectionParts(partsToProcess, context);
    return this.applyIntersectionDocs(merged);
  }

  /**
   * Returns true if the type is "brand-only" or an empty object — i.e. it carries
   * no string-keyed data properties and no index signatures.
   *
   * These parts can be safely dropped from an intersection for schema purposes:
   *   - `{}` (empty object) — e.g. the second part of RequireDefaults<number[]>
   *   - `{ readonly [DEFAULT_MARKER]: T }` — the brand object inside Default<T,V>
   */
  private isBrandOnlyOrEmpty(part: ts.Type, checker: ts.TypeChecker): boolean {
    if ((part.flags & ts.TypeFlags.Object) === 0) return false;

    try {
      const stringIndex = checker.getIndexTypeOfType(
        part,
        ts.IndexKind.String,
      );
      const numberIndex = checker.getIndexTypeOfType(
        part,
        ts.IndexKind.Number,
      );
      if (stringIndex || numberIndex) return false;
    } catch {
      return false;
    }

    const properties = checker.getPropertiesOfType(part);
    for (const prop of properties) {
      // TypeScript encodes unique-symbol property names as "__@..." internally.
      // Any property whose escapedName does NOT start with "__@" is a regular
      // string-keyed property — making this a real data type, not a brand.
      // There is no public TypeScript API to distinguish symbol-keyed from
      // string-keyed properties, so we rely on this internal naming convention
      // intentionally.
      const escaped = prop.escapedName as string;
      if (!String(escaped).startsWith("__@")) {
        return false;
      }
    }

    return true;
  }

  private validateIntersectionParts(
    parts: readonly ts.Type[],
    checker: ts.TypeChecker,
  ): string | null {
    for (const part of parts) {
      if ((part.flags & ts.TypeFlags.Object) === 0) {
        return "non-object constituent";
      }

      try {
        const stringIndex = checker.getIndexTypeOfType(
          part,
          ts.IndexKind.String,
        );
        const numberIndex = checker.getIndexTypeOfType(
          part,
          ts.IndexKind.Number,
        );
        if (stringIndex || numberIndex) {
          return "index signature on constituent";
        }
      } catch (error) {
        return `checker error while validating intersection: ${error}`;
      }
    }

    return null;
  }

  private mergeIntersectionParts(
    parts: readonly ts.Type[],
    context: GenerationContext,
  ): {
    schema: JSONSchemaMutable;
    docTexts: string[];
    documentedSources: string[];
    missingSources: string[];
  } {
    const mergedProps: Record<string, JSONSchemaMutableOrBoolean> = {};
    const requiredSet = new Set<string>();

    const docTexts: string[] = [];
    const documentedSources: string[] = [];
    const missingSources: string[] = [];

    for (const part of parts) {
      const docInfo = extractDocFromType(part, context.typeChecker);
      if (docInfo.firstDoc) {
        docTexts.push(docInfo.firstDoc);
        documentedSources.push(docInfo.typeName);
      } else {
        missingSources.push(docInfo.typeName);
      }

      const schema = this.schemaGenerator.formatChildType(part, context);
      const objSchema = this.resolveObjectSchema(schema, context);
      if (!objSchema) continue;

      if (objSchema.properties) {
        for (const [key, value] of Object.entries(objSchema.properties)) {
          const existing = mergedProps[key];
          if (existing) {
            if (isRecord(existing) && isRecord(value)) {
              const aDesc = typeof existing.description === "string"
                ? existing.description as string
                : undefined;
              const bDesc = typeof value.description === "string"
                ? value.description as string
                : undefined;
              if (aDesc && bDesc && aDesc !== bDesc) {
                const priorComment = typeof existing.$comment === "string"
                  ? existing.$comment as string
                  : undefined;
                (existing as Record<string, unknown>).$comment = priorComment ??
                  DOC_CONFLICT_COMMENT;
                logger.warn(
                  "schema-gen",
                  () => `Intersection doc conflict for '${key}'; using first`,
                );
              }
            }
            logger.debug(
              "schema-gen",
              () => `Intersection kept first definition for '${key}'`,
            );
            continue;
          }
          mergedProps[key] = value;
        }
      }

      if (Array.isArray(objSchema.required)) {
        for (const req of objSchema.required) {
          if (typeof req === "string") requiredSet.add(req);
        }
      }
    }

    const result: JSONSchemaMutable = {
      type: "object",
      properties: mergedProps,
    };

    if (requiredSet.size > 0) {
      result.required = Array.from(requiredSet);
    }

    return { schema: result, docTexts, documentedSources, missingSources };
  }

  private isObjectSchema(
    schema: JSONSchemaMutableOrBoolean,
  ): schema is JSONSchemaMutable & { type: "object" } {
    return (
      typeof schema === "object" &&
      schema !== null &&
      schema.type === "object"
    );
  }

  private resolveObjectSchema(
    schema: JSONSchemaMutableOrBoolean,
    context: GenerationContext,
  ): (JSONSchemaMutable & { type: "object" }) | undefined {
    if (this.isObjectSchema(schema)) return schema;
    if (
      typeof schema === "object" &&
      schema !== null &&
      typeof (schema as Record<string, unknown>).$ref === "string"
    ) {
      const ref = (schema as Record<string, unknown>).$ref as string;
      const prefix = "#/$defs/";
      if (ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length);
        const def = context.definitions[name];
        if (def && this.isObjectSchema(def)) return def;
      }
    }
    return undefined;
  }

  private applyIntersectionDocs(
    data: {
      schema: JSONSchemaMutable;
      docTexts: string[];
      documentedSources: string[];
      missingSources: string[];
    },
  ): JSONSchemaMutable {
    const { schema, docTexts, documentedSources, missingSources } = data;
    if (!isRecord(schema)) return schema;

    const uniqueDocTexts = docTexts.filter((doc, index, arr) =>
      arr.indexOf(doc) === index
    );

    if (
      uniqueDocTexts.length > 0 && typeof schema.description !== "string"
    ) {
      (schema as Record<string, unknown>).description = uniqueDocTexts.join(
        "\n\n",
      );
    }

    const commentParts: string[] = [];
    const existingComment = typeof schema.$comment === "string"
      ? schema.$comment as string
      : undefined;

    const uniqueDocumented = Array.from(new Set(documentedSources)).filter((
      name,
    ) => name);
    const uniqueMissing = Array.from(new Set(missingSources)).filter((name) =>
      name
    );

    if (uniqueDocTexts.length > 0) {
      commentParts.push("Docs inherited from intersection constituents.");
    }
    if (uniqueDocTexts.length > 1 && uniqueDocumented.length > 0) {
      commentParts.push(`Sources: ${uniqueDocumented.join(", ")}.`);
    }
    if (uniqueDocTexts.length > 0 && uniqueMissing.length > 0) {
      commentParts.push(`Missing docs for: ${uniqueMissing.join(", ")}.`);
    }

    if (commentParts.length > 0) {
      const commentMessage = commentParts.join(" ");
      (schema as Record<string, unknown>).$comment = existingComment
        ? `${existingComment} ${commentMessage}`
        : commentMessage;
    }

    return schema;
  }
}
