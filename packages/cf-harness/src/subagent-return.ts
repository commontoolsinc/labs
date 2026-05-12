import type { JSONSchema } from "@commonfabric/api";
import {
  DEFAULT_STRUCTURED_RESULT_SCHEMA_MAX_BYTES,
  type ParsedStructuredResultSchema,
  parseStructuredResultJson,
  parseStructuredResultSchema,
  type SanitizedStructuredResult,
  validateAndSanitizeStructuredResult,
} from "./structured-result.ts";

export const MAX_SUBAGENT_RETURN_SCHEMA_BYTES =
  DEFAULT_STRUCTURED_RESULT_SCHEMA_MAX_BYTES;

export type { ParsedStructuredResultSchema as ParsedSubagentReturnSchema };
export type { SanitizedStructuredResult as SanitizedSubagentReturn };

export const parseSubagentReturnSchema = (
  input: unknown,
): ParsedStructuredResultSchema | undefined =>
  parseStructuredResultSchema(input, {
    label: "delegate_task returnSchema",
    maxBytes: MAX_SUBAGENT_RETURN_SCHEMA_BYTES,
  });

export const parseSubagentReturnJson = (text: string): unknown =>
  parseStructuredResultJson(text, {
    emptyMessage: "child final response was empty",
    invalidMessage: "child final response was not valid JSON",
  });

export const validateAndSanitizeSubagentReturn = (
  options: {
    schema: JSONSchema;
    value: unknown;
    childRunId: string;
  },
): SanitizedStructuredResult =>
  validateAndSanitizeStructuredResult({
    schema: options.schema,
    value: options.value,
    opaqueHandleId: options.childRunId,
  });
