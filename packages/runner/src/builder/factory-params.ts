import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  factorySchemasEqual,
  resolveLocalSchemaRef,
} from "@commonfabric/data-model/schema-utils";
import { isRecord } from "@commonfabric/utils/types";

import { validateAgainstSchema } from "../cfc/schema-sanitization.ts";
import {
  type FactoryContract,
  factoryContractFromSchema,
} from "../factory-contract.ts";
import { isCell } from "../cell.ts";
import { isCellLink, parseLink } from "../link-utils.ts";
import { isCellScope } from "../scope.ts";
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
  const current = resolveLocalSchemaRef(schema.$ref, root);
  if (current === undefined) return undefined;
  const { $ref: _, ...siblings } = schema;
  if (Object.keys(siblings).length === 0) return current as JSONSchema;
  if (current === false) return false;
  if (current !== true) {
    const overlappingKeys = Object.keys(siblings).filter((key) =>
      Object.hasOwn(current, key)
    );
    if (overlappingKeys.length > 0) {
      const combined: Record<string, unknown> = {
        allOf: [current, siblings],
      };
      // These runtime contract annotations must remain visible at the schema
      // root while the overlapping JSON Schema constraints retain their
      // conjunctive `$ref`-sibling meaning inside `allOf`.
      for (const key of ["asCell", "asFactory", "scope"] as const) {
        if (Object.hasOwn(current, key) !== Object.hasOwn(siblings, key)) {
          combined[key] = Object.hasOwn(siblings, key)
            ? siblings[key]
            : current[key];
        }
      }
      return schemaWithRootDefinitions(combined as JSONSchema, root);
    }
  }
  return schemaWithRootDefinitions(
    current === true ? siblings : { ...current, ...siblings },
    root,
  );
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

function isRunnerCellBinding(value: unknown): boolean {
  if (isCell(value) || isCellLink(value)) return true;
  if (!isReactive(value)) return false;
  return isCell(value.export().cell);
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

function withoutNestedAsCell(schema: JSONSchema): JSONSchema {
  if (schema === true || schema === false) return schema;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "asCell")
        .map(([key, child]) => [key, visit(child)]),
    );
  };
  return visit(schema) as JSONSchema;
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

function symbolicCellEntries(
  source: JSONSchema,
  value: unknown,
): { kind: string; scope?: string }[] {
  const sourceEntries = source !== true && source !== false &&
      Array.isArray(source.asCell)
    ? source.asCell.map(asCellEntry).filter((entry) => entry !== undefined)
    : [];
  if (sourceEntries.length > 0) return sourceEntries;
  const sourceScope = source !== true && source !== false &&
      isCellScope(source.scope)
    ? source.scope
    : undefined;
  const exportedCell = isCell(value) ? value.export() : undefined;
  const isStreamCell = isRecord(exportedCell?.value) &&
    exportedCell.value.$stream === true;
  return isStreamCell
    ? [{ kind: "stream", scope: sourceScope ?? exportedCell?.scope }]
    : isCell(value)
    ? [{ kind: "cell", scope: sourceScope ?? exportedCell?.scope }]
    : isCellLink(value)
    ? [{ kind: "cell", scope: sourceScope ?? parseLink(value)?.scope }]
    : [];
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
  const actualEntries = symbolicCellEntries(source, value);
  if (
    !expectedEntries.some((expectedEntry) =>
      actualEntries.some((actualEntry) =>
        expectedEntry.kind === actualEntry.kind &&
        (expectedEntry.scope === undefined || expectedEntry.scope === "any" ||
          expectedEntry.scope === actualEntry.scope)
      )
    )
  ) {
    const describe = (entry: { kind: string; scope?: string }) =>
      `${entry.kind}@${entry.scope ?? "unspecified"}`;
    return `symbolic binding cell kind mismatch: expected ${
      expectedEntries.map(describe).join("|")
    }, got ${actualEntries.map(describe).join("|") || "none"}`;
  }
  return undefined;
}

function sourceSchemaContainsExpected(
  expected: unknown,
  source: unknown,
  keyword?: string,
  expectedRoot?: JSONSchema,
  sourceRoot?: JSONSchema,
  seenRefs = new Set<string>(),
): boolean {
  if (
    expectedRoot === undefined &&
    (typeof expected === "boolean" || isRecord(expected))
  ) {
    expectedRoot = expected as JSONSchema;
  }
  if (
    sourceRoot === undefined &&
    (typeof source === "boolean" || isRecord(source))
  ) {
    sourceRoot = source as JSONSchema;
  }
  if (
    isRecord(expected) && typeof expected.$ref === "string" &&
    expected.$ref.startsWith("#/") && expectedRoot !== undefined
  ) {
    const sourceRef = isRecord(source) && typeof source.$ref === "string"
      ? source.$ref
      : "<inline>";
    const refPair = `expected:${expected.$ref}|source:${sourceRef}`;
    if (seenRefs.has(refPair)) return true;
    const resolved = schemaAtRef(expected as JSONSchema, expectedRoot);
    if (resolved === undefined || resolved === expected) return false;
    const nextSeen = new Set(seenRefs);
    nextSeen.add(refPair);
    return sourceSchemaContainsExpected(
      resolved,
      source,
      keyword,
      expectedRoot,
      sourceRoot,
      nextSeen,
    );
  }
  if (
    isRecord(source) && typeof source.$ref === "string" &&
    source.$ref.startsWith("#/") && sourceRoot !== undefined
  ) {
    const expectedRef = isRecord(expected) && typeof expected.$ref === "string"
      ? expected.$ref
      : "<inline>";
    const refPair = `expected:${expectedRef}|source:${source.$ref}`;
    if (seenRefs.has(refPair)) return true;
    const resolved = schemaAtRef(source as JSONSchema, sourceRoot);
    if (resolved === undefined || resolved === source) return false;
    const nextSeen = new Set(seenRefs);
    nextSeen.add(refPair);
    return sourceSchemaContainsExpected(
      expected,
      resolved,
      keyword,
      expectedRoot,
      sourceRoot,
      nextSeen,
    );
  }
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
        sourceSchemaContainsExpected(
          entry,
          source[index],
          undefined,
          expectedRoot,
          sourceRoot,
          seenRefs,
        )
      );
  }
  if (isRecord(expected)) {
    if (!isRecord(source) || Array.isArray(source)) return false;
    const expectedSchema = expected as JSONSchema;
    const validationRoot = expectedRoot ?? expectedSchema;
    if (
      Object.hasOwn(source, "const") &&
      validateAgainstSchema(
          expectedSchema,
          source.const,
          validationRoot,
        ) === undefined
    ) {
      return true;
    }
    if (
      Array.isArray(source.enum) &&
      source.enum.every((entry) =>
        validateAgainstSchema(expectedSchema, entry, validationRoot) ===
          undefined
      )
    ) {
      return true;
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (key === "$defs" || key === "definitions") continue;
      if (!Object.hasOwn(source, key)) return false;
      if (
        !sourceSchemaContainsExpected(
          expectedValue,
          source[key],
          key,
          expectedRoot,
          sourceRoot,
          seenRefs,
        )
      ) {
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
  if (
    sourceSchema === undefined ||
    (isCell(value) && isPlainRecord(sourceSchema) &&
      Object.keys(sourceSchema).length === 0)
  ) {
    // Some trusted builder Cells (notably dynamic-schema builtin results such
    // as wish().result paths) carry no local content schema — represented as
    // either undefined or the equivalent empty JSON Schema — at eager graph
    // construction time. The compiler-generated params schema remains
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
  // A runner Cell binding (live or serialized) has already established the
  // outer symbolic capability. Its exported content schema may have nested
  // `asCell` annotations removed by durable-link schema sanitization, so
  // compare the remaining content contract without treating that serialization
  // detail as authored evidence. Reactive-shaped objects do not receive this.
  const runnerCellBinding = isRunnerCellBinding(value);
  const comparableExpected = runnerCellBinding
    ? withoutNestedAsCell(expectedContent)
    : expectedContent;
  const comparableSource = runnerCellBinding
    ? withoutNestedAsCell(sourceContent)
    : sourceContent;
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
  return factorySchemasEqual(comparableExpected, comparableSource) ||
      sourceSchemaContainsExpected(comparableExpected, comparableSource) ||
      rootedSchema !== true && rootedSchema !== false &&
        Array.isArray(rootedSchema.asCell) &&
        rootedSchema.asCell.map(asCellEntry).some((entry) =>
          entry?.kind === "stream"
        ) &&
        symbolicCellEntries(sourceSchema, value).some((entry) =>
          entry.kind === "stream"
        ) &&
        sourceSchemaContainsExpected(comparableSource, comparableExpected)
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
