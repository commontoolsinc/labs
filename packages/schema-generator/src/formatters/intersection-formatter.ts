import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { cloneSchemaDefinition, getNativeTypeSchema } from "../type-utils.ts";
import { getLogger } from "@commontools/utils/logger";
import { isRecord } from "@commontools/utils/types";
import { extractDocFromType } from "../doc-utils.ts";

const logger = getLogger("schema-generator.intersection");
const DOC_CONFLICT_COMMENT =
  "Conflicting docs across intersection constituents; using first";

export class IntersectionFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, _context: GenerationContext): boolean {
    return (type.flags & ts.TypeFlags.Intersection) !== 0;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
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

    const failureReason = this.validateIntersectionParts(parts, checker);
    if (failureReason) {
      return {
        type: "object",
        additionalProperties: true,
        $comment: `Unsupported intersection pattern: ${failureReason}`,
      };
    }

    const merged = this.mergeIntersectionParts(parts, context);
    return this.applyIntersectionDocs(merged);
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
    schema: SchemaDefinition;
    docTexts: string[];
    documentedSources: string[];
    missingSources: string[];
  } {
    const mergedProps: Record<string, SchemaDefinition> = {};
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
                logger.warn(() =>
                  `Intersection doc conflict for '${key}'; using first`
                );
              }
            }
            logger.debug(() =>
              `Intersection kept first definition for '${key}'`
            );
            continue;
          }
          mergedProps[key] = value as SchemaDefinition;
        }
      }

      if (Array.isArray(objSchema.required)) {
        for (const req of objSchema.required) {
          if (typeof req === "string") requiredSet.add(req);
        }
      }
    }

    const result: SchemaDefinition = {
      type: "object",
      properties: mergedProps,
    };

    if (requiredSet.size > 0) {
      result.required = Array.from(requiredSet);
    }

    return { schema: result, docTexts, documentedSources, missingSources };
  }

  private isObjectSchema(
    schema: SchemaDefinition,
  ): schema is SchemaDefinition & {
    properties?: Record<string, SchemaDefinition>;
    required?: string[];
  } {
    return (
      typeof schema === "object" &&
      schema !== null &&
      schema.type === "object"
    );
  }

  private resolveObjectSchema(
    schema: SchemaDefinition,
    context: GenerationContext,
  ):
    | (SchemaDefinition & {
      properties?: Record<string, SchemaDefinition>;
      required?: string[];
    })
    | undefined {
    if (this.isObjectSchema(schema)) return schema;
    if (
      typeof schema === "object" &&
      schema !== null &&
      typeof (schema as Record<string, unknown>).$ref === "string"
    ) {
      const ref = (schema as Record<string, unknown>).$ref as string;
      const prefix = "#/definitions/";
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
      schema: SchemaDefinition;
      docTexts: string[];
      documentedSources: string[];
      missingSources: string[];
    },
  ): SchemaDefinition {
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
