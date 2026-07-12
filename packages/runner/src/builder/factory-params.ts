import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import { factorySchemasEqual } from "@commonfabric/data-model/schema-utils";
import { isRecord } from "@commonfabric/utils/types";

import { validateAgainstSchema } from "../cfc/schema-sanitization.ts";
import {
  type FactoryContract,
  factoryContractFromSchema,
} from "../factory-contract.ts";
import { isCell } from "../cell.ts";
import { isCellLink, parseLink } from "../link-utils.ts";
import { isReactive, type JSONSchema } from "./types.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaAtRef(
  schema: JSONSchema,
  root: JSONSchema,
): JSONSchema | undefined {
  if (
    schema === true || schema === false ||
    typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/") ||
    root === true || root === false
  ) return schema;
  let current: unknown = root;
  for (const encoded of schema.$ref.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current[key];
  }
  return typeof current === "boolean" || isRecord(current)
    ? current as JSONSchema
    : undefined;
}

function contractFromState(value: unknown): FactoryContract {
  const state = factoryStateOf(value);
  switch (state.kind) {
    case "pattern":
      return {
        kind: "pattern",
        argumentSchema: state.argumentSchema!,
        resultSchema: state.resultSchema!,
      };
    case "module":
      return {
        kind: "module",
        argumentSchema: state.argumentSchema,
        resultSchema: state.resultSchema,
      };
    case "handler":
      return {
        kind: "handler",
        contextSchema: state.contextSchema,
        eventSchema: state.eventSchema,
      };
  }
}

function factoryContractFailure(
  expected: FactoryContract,
  actual: FactoryContract,
): string | undefined {
  if (expected.kind !== actual.kind) {
    return `factory kind mismatch: expected ${expected.kind}, got ${actual.kind}`;
  }
  const pairs = expected.kind === "handler"
    ? [
      [expected.contextSchema, (actual as typeof expected).contextSchema],
      [expected.eventSchema, (actual as typeof expected).eventSchema],
    ] as const
    : [
      [expected.argumentSchema, (actual as typeof expected).argumentSchema],
      [expected.resultSchema, (actual as typeof expected).resultSchema],
    ] as const;
  return pairs.every(([left, right]) => factorySchemasEqual(left, right))
    ? undefined
    : `factory schema mismatch for ${expected.kind}`;
}

function symbolicSchema(value: unknown): JSONSchema | undefined {
  // Eager graph construction can hand curry an opaque Cell whose frame has no
  // runtime space yet. Its authored schema is already available on the Cell;
  // parsing it as a link would incorrectly force identity/space minting during
  // compile-time validation.
  if (isCell(value)) {
    return value.export().schema;
  }
  if (isReactive(value)) {
    return value.export().schema;
  }
  if (isCellLink(value)) {
    return parseLink(value).schema;
  }
  return undefined;
}

function isSymbolicValue(value: unknown): boolean {
  return isReactive(value) || isCellLink(value);
}

function schemaWithRootDefinitions(
  schema: JSONSchema,
  root: JSONSchema,
): JSONSchema {
  if (schema === true || schema === false || root === true || root === false) {
    return schema;
  }
  const rooted = { ...schema };
  if (rooted.$defs === undefined && root.$defs !== undefined) {
    rooted.$defs = root.$defs;
  }
  if (rooted.definitions === undefined && root.definitions !== undefined) {
    rooted.definitions = root.definitions;
  }
  return rooted;
}

function withoutAsCell(schema: JSONSchema): JSONSchema {
  if (schema === true || schema === false || schema.asCell === undefined) {
    return schema;
  }
  const contentSchema = { ...schema };
  delete contentSchema.asCell;
  return contentSchema;
}

function asCellEntry(value: unknown):
  | { kind: string; scope?: string }
  | undefined {
  if (typeof value === "string") return { kind: value };
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  return {
    kind: value.kind,
    scope: typeof value.scope === "string" ? value.scope : undefined,
  };
}

function symbolicCellKindFailure(
  expected: JSONSchema,
  source: JSONSchema,
  value: unknown,
): string | undefined {
  if (
    expected === true || expected === false || !Array.isArray(expected.asCell)
  ) {
    return undefined;
  }
  const expectedEntries = expected.asCell.map(asCellEntry).filter((entry) =>
    entry !== undefined
  );
  if (expectedEntries.length === 0) return undefined;

  const sourceEntries = source !== true && source !== false &&
      Array.isArray(source.asCell)
    ? source.asCell.map(asCellEntry).filter((entry) => entry !== undefined)
    : [];
  const exportedCell = isCell(value) ? value.export() : undefined;
  const isStreamCell = isRecord(exportedCell?.value) &&
    exportedCell.value.$stream === true;
  const actualEntries = sourceEntries.length > 0
    ? sourceEntries
    : (isStreamCell
      ? [{ kind: "stream", scope: exportedCell?.scope }]
      : isCell(value)
      ? [{ kind: "cell", scope: exportedCell?.scope }]
      : isCellLink(value)
      ? [{ kind: "cell", scope: parseLink(value)?.scope }]
      : []);
  if (
    !expectedEntries.some((expectedEntry) =>
      actualEntries.some((actualEntry) =>
        expectedEntry.kind === actualEntry.kind &&
        (expectedEntry.scope === undefined || expectedEntry.scope === "any" ||
          expectedEntry.scope === actualEntry.scope)
      )
    )
  ) {
    return `symbolic binding cell kind mismatch: expected ${
      expectedEntries.map((entry) => entry.kind).join("|")
    }, got ${actualEntries.map((entry) => entry.kind).join("|") || "none"}`;
  }
  return undefined;
}

function sourceSchemaContainsExpected(
  expected: unknown,
  source: unknown,
  keyword?: string,
): boolean {
  if (expected === true) return true;
  if (source === false) return true;
  if (expected === false) return expected === source;
  if (source === true) {
    return isRecord(expected) &&
      Object.keys(expected).every((key) =>
        key === "$defs" || key === "definitions"
      );
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(source)) return false;
    if (keyword === "required") {
      return expected.every((entry) => source.some((value) => value === entry));
    }
    return expected.length === source.length &&
      expected.every((entry, index) =>
        sourceSchemaContainsExpected(entry, source[index])
      );
  }
  if (isRecord(expected)) {
    if (!isRecord(source) || Array.isArray(source)) return false;
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (key === "$defs" || key === "definitions") continue;
      if (!Object.hasOwn(source, key)) return false;
      if (!sourceSchemaContainsExpected(expectedValue, source[key], key)) {
        return false;
      }
    }
    return true;
  }
  return Object.is(expected, source);
}

function symbolicFailure(
  schema: JSONSchema,
  value: unknown,
  root: JSONSchema,
): string | undefined {
  const rootedSchema = schemaWithRootDefinitions(schema, root);
  const expectedFactory = factoryContractFromSchema(rootedSchema);
  const sourceSchema = symbolicSchema(value);
  if (expectedFactory !== undefined) {
    const sourceFactory = factoryContractFromSchema(sourceSchema);
    if (sourceFactory === undefined) {
      return "symbolic factory binding lacks a trusted factory schema";
    }
    return factoryContractFailure(expectedFactory, sourceFactory);
  }
  if (schema === true) return undefined;
  if (sourceSchema === undefined) {
    // Some trusted builder Cells (notably dynamic-schema builtin results such
    // as wish().result paths) do not carry a local content schema at eager
    // graph-construction time. The compiler-generated params schema remains
    // authoritative for their eventual content; still enforce any declared
    // Cell/Stream kind and never extend this allowance to serialized links or
    // arbitrary reactive-shaped objects.
    if (isCell(value)) {
      return symbolicCellKindFailure(rootedSchema, true, value);
    }
    return "symbolic binding lacks a trusted schema";
  }
  const cellKindFailure = symbolicCellKindFailure(
    rootedSchema,
    sourceSchema,
    value,
  );
  if (cellKindFailure !== undefined) return cellKindFailure;
  const expectedContent = withoutAsCell(rootedSchema);
  const resolvedSourceSchema = schemaAtRef(sourceSchema, sourceSchema) ??
    sourceSchema;
  const sourceContent = withoutAsCell(
    schemaWithRootDefinitions(resolvedSourceSchema, sourceSchema),
  );
  if (
    sourceSchema !== true && sourceSchema !== false &&
    Object.hasOwn(sourceSchema, "default") &&
    validateAgainstSchema(
        expectedContent,
        sourceSchema.default,
        rootedSchema,
      ) === undefined
  ) {
    return undefined;
  }
  return factorySchemasEqual(expectedContent, sourceContent) ||
      sourceSchemaContainsExpected(expectedContent, sourceContent)
    ? undefined
    : `symbolic binding schema mismatch: expected ${
      JSON.stringify(expectedContent)
    }, got ${JSON.stringify(sourceContent)}`;
}

function validateSymbolicValue(
  schema: JSONSchema,
  value: unknown,
  root: JSONSchema,
  seenRefs: Set<string>,
): string | undefined {
  const resolved = schemaAtRef(schema, root);
  if (resolved === undefined) return "unresolved schema reference";
  if (resolved !== schema) {
    const ref = schema !== true && schema !== false ? schema.$ref : undefined;
    if (ref !== undefined) {
      if (seenRefs.has(ref)) return "cyclic schema reference";
      const nextSeen = new Set(seenRefs);
      nextSeen.add(ref);
      return validateSymbolicValue(resolved, value, root, nextSeen);
    }
  }
  schema = resolved;
  if (schema === false) return "schema rejects all values";
  if (schema === true) return undefined;

  // A symbolic cell can itself carry the complete union/intersection schema.
  // Compare that contract before treating compound keywords as alternatives
  // for a concrete runtime value. Otherwise an optional Cell<T | undefined>
  // is incorrectly compared with each value branch (T and undefined) and can
  // satisfy neither even though its trusted schema exactly matches the whole
  // capture contract.
  if (
    isSymbolicValue(value) &&
    (Array.isArray(schema.allOf) || Array.isArray(schema.anyOf) ||
      Array.isArray(schema.oneOf)) &&
    symbolicFailure(schema, value, root) === undefined
  ) {
    return undefined;
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const failure = validateSymbolicValue(branch, value, root, seenRefs);
      if (failure !== undefined) return failure;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    if (
      !schema.anyOf.some((branch) =>
        validateSymbolicValue(branch, value, root, seenRefs) === undefined
      )
    ) {
      return `value does not match anyOf (source schema ${
        JSON.stringify(symbolicSchema(value))
      })`;
    }
    return undefined;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) =>
      validateSymbolicValue(branch, value, root, seenRefs) === undefined
    ).length;
    if (matches !== 1) {
      return "value does not match exactly one oneOf branch";
    }
    return undefined;
  }

  if (isSymbolicValue(value)) {
    return symbolicFailure(schema, value, root);
  }
  if (typeof value === "function") {
    if (!isAdmittedFabricFactory(value)) {
      return "arbitrary functions are not valid pattern params";
    }
    const expected = factoryContractFromSchema(schema);
    if (expected === undefined) {
      return "factory value requires an asFactory schema";
    }
    return factoryContractFailure(expected, contractFromState(value));
  }

  if (Array.isArray(value)) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (schema.type !== undefined && !types.includes("array")) {
      return `value does not match type ${types.join("|")}`;
    }
    if (typeof schema.items === "object") {
      for (let index = 0; index < value.length; index++) {
        const failure = validateSymbolicValue(
          schema.items,
          value[index],
          root,
          seenRefs,
        );
        if (failure !== undefined) return `${index}: ${failure}`;
      }
    }
    return undefined;
  }

  if (isPlainRecord(value)) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (schema.type !== undefined && !types.includes("object")) {
      return `value does not match type ${types.join("|")}`;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `missing required property ${key}`;
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const failure = validateSymbolicValue(
        child,
        value[key],
        root,
        seenRefs,
      );
      if (failure !== undefined) return `${key}: ${failure}`;
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) continue;
      if (schema.additionalProperties === false) {
        return `additional property ${key}`;
      }
      if (isRecord(schema.additionalProperties)) {
        const failure = validateSymbolicValue(
          schema.additionalProperties as JSONSchema,
          value[key],
          root,
          seenRefs,
        );
        if (failure !== undefined) return `${key}: ${failure}`;
      }
    }
    return undefined;
  }

  return validateAgainstSchema(schema, value, root);
}

export function assertValidPatternParams(
  params: unknown,
  schema: JSONSchema,
): void {
  if (!isPlainRecord(params)) {
    throw new TypeError("Pattern curry params must be a plain object");
  }
  const failure = validateSymbolicValue(schema, params, schema, new Set());
  if (failure !== undefined) {
    throw new TypeError(`Invalid pattern params: ${failure}`);
  }
}
