import type { Cell } from "@commonfabric/api";
import {
  ContextualFlowControl,
  createBuilder,
  deepEqual,
  type JSONSchema,
  KeepAsCell,
  type MemorySpace,
  type Runtime,
  sanitizeSchemaForLinks,
} from "@commonfabric/runner";
import { isRecord } from "@commonfabric/utils/types";
import { runtimeErrorLog } from "./callable.ts";

type PredicateComparisonOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type PieceGetPredicate =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "path"; path: Array<string | number> }
  | { kind: "not"; value: PieceGetPredicate }
  | {
    kind: "boolean";
    operator: "and" | "or";
    left: PieceGetPredicate;
    right: PieceGetPredicate;
  }
  | {
    kind: "comparison";
    operator: PredicateComparisonOperator;
    left: PieceGetPredicate;
    right: PieceGetPredicate;
  };

export interface ParsedPieceGetFilter {
  source: string;
  predicate: PieceGetPredicate;
  paths: Array<Array<string | number>>;
}

export interface PieceGetProjection {
  source: string;
  schema: JSONSchema;
  kind: "concise" | "json";
}

export interface PieceGetTransform {
  filter?: ParsedPieceGetFilter;
  projection?: PieceGetProjection;
}

export class PieceGetTransformError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PieceGetTransformError";
  }
}

type TokenKind =
  | "dot"
  | "left-bracket"
  | "right-bracket"
  | "left-paren"
  | "right-paren"
  | "operator"
  | "identifier"
  | "string"
  | "number"
  | "eof";

interface Token {
  kind: TokenKind;
  value?: string | number;
  position: number;
}

function expressionError(source: string, position: number, message: string) {
  return new PieceGetTransformError(
    `Invalid --filter predicate at column ${position + 1}: ${message}\n` +
      `  ${source}`,
  );
}

function tokenizePredicate(source: string): Token[] {
  const result: Token[] = [];
  let position = 0;

  while (position < source.length) {
    const char = source[position];
    if (/\s/.test(char)) {
      position++;
      continue;
    }
    const punctuation: Partial<Record<string, TokenKind>> = {
      ".": "dot",
      "[": "left-bracket",
      "]": "right-bracket",
      "(": "left-paren",
      ")": "right-paren",
    };
    const punctuationKind = punctuation[char];
    if (punctuationKind !== undefined) {
      result.push({ kind: punctuationKind, position });
      position++;
      continue;
    }

    const operator = source.slice(position).match(/^(==|!=|<=|>=|<|>)/)?.[0];
    if (operator !== undefined) {
      result.push({ kind: "operator", value: operator, position });
      position += operator.length;
      continue;
    }

    if (char === '"') {
      let end = position + 1;
      let escaped = false;
      for (; end < source.length; end++) {
        const candidate = source[end];
        if (!escaped && candidate === '"') break;
        if (!escaped && candidate === "\\") {
          escaped = true;
        } else {
          escaped = false;
        }
      }
      if (end >= source.length) {
        throw expressionError(source, position, "unterminated string literal");
      }
      const literal = source.slice(position, end + 1);
      let value: string;
      try {
        value = JSON.parse(literal);
      } catch {
        throw expressionError(source, position, "invalid string literal");
      }
      result.push({ kind: "string", value, position });
      position = end + 1;
      continue;
    }

    const number = source.slice(position).match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
    )?.[0];
    if (number !== undefined) {
      result.push({ kind: "number", value: Number(number), position });
      position += number.length;
      continue;
    }

    const identifier = source.slice(position).match(
      /^[A-Za-z_$][A-Za-z0-9_$-]*/,
    )?.[0];
    if (identifier !== undefined) {
      result.push({ kind: "identifier", value: identifier, position });
      position += identifier.length;
      continue;
    }

    throw expressionError(
      source,
      position,
      `unexpected character ${JSON.stringify(char)}`,
    );
  }

  result.push({ kind: "eof", position: source.length });
  return result;
}

class PredicateParser {
  #index = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
  ) {}

  parse(): PieceGetPredicate {
    const result = this.#parseOr();
    const trailing = this.#peek();
    if (trailing.kind !== "eof") {
      throw expressionError(
        this.source,
        trailing.position,
        "unexpected trailing input",
      );
    }
    return result;
  }

  #peek(): Token {
    return this.tokens[this.#index];
  }

  #take(): Token {
    return this.tokens[this.#index++];
  }

  #takeKind(kind: TokenKind, message: string): Token {
    const token = this.#peek();
    if (token.kind !== kind) {
      throw expressionError(this.source, token.position, message);
    }
    return this.#take();
  }

  #takeKeyword(keyword: string): boolean {
    const token = this.#peek();
    if (token.kind === "identifier" && token.value === keyword) {
      this.#take();
      return true;
    }
    return false;
  }

  #parseOr(): PieceGetPredicate {
    let left = this.#parseAnd();
    while (this.#takeKeyword("or")) {
      left = {
        kind: "boolean",
        operator: "or",
        left,
        right: this.#parseAnd(),
      };
    }
    return left;
  }

  #parseAnd(): PieceGetPredicate {
    let left = this.#parseComparison();
    while (this.#takeKeyword("and")) {
      left = {
        kind: "boolean",
        operator: "and",
        left,
        right: this.#parseComparison(),
      };
    }
    return left;
  }

  #parseComparison(): PieceGetPredicate {
    const left = this.#parseUnary();
    const token = this.#peek();
    if (token.kind !== "operator") return left;
    this.#take();
    return {
      kind: "comparison",
      operator: token.value as PredicateComparisonOperator,
      left,
      right: this.#parseUnary(),
    };
  }

  #parseUnary(): PieceGetPredicate {
    if (this.#takeKeyword("not")) {
      return { kind: "not", value: this.#parseUnary() };
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): PieceGetPredicate {
    const token = this.#peek();
    if (token.kind === "left-paren") {
      this.#take();
      const result = this.#parseOr();
      this.#takeKind("right-paren", 'expected ")"');
      return result;
    }
    if (token.kind === "dot") return this.#parsePath();
    if (token.kind === "string" || token.kind === "number") {
      this.#take();
      return {
        kind: "literal",
        value: token.value as string | number,
      };
    }
    if (token.kind === "identifier") {
      const literal = token.value === "true"
        ? true
        : token.value === "false"
        ? false
        : token.value === "null"
        ? null
        : undefined;
      if (literal !== undefined || token.value === "null") {
        this.#take();
        return { kind: "literal", value: literal ?? null };
      }
    }
    throw expressionError(
      this.source,
      token.position,
      "expected a path, literal, or parenthesized expression",
    );
  }

  #parsePath(): PieceGetPredicate {
    this.#take();
    const path: Array<string | number> = [];
    const first = this.#peek();
    if (first.kind === "identifier") {
      path.push(String(this.#take().value));
    }

    while (true) {
      const token = this.#peek();
      if (token.kind === "dot") {
        this.#take();
        path.push(
          String(
            this.#takeKind(
              "identifier",
              "expected a property name after dot",
            ).value,
          ),
        );
        continue;
      }
      if (token.kind === "left-bracket") {
        this.#take();
        const segment = this.#peek();
        if (segment.kind !== "string" && segment.kind !== "number") {
          throw expressionError(
            this.source,
            segment.position,
            "expected a string or number inside brackets",
          );
        }
        this.#take();
        path.push(segment.value as string | number);
        this.#takeKind("right-bracket", 'expected "]"');
        continue;
      }
      break;
    }
    return { kind: "path", path };
  }
}

function collectPredicatePaths(
  predicate: PieceGetPredicate,
  result: Array<Array<string | number>>,
): void {
  switch (predicate.kind) {
    case "path":
      result.push(predicate.path);
      break;
    case "not":
      collectPredicatePaths(predicate.value, result);
      break;
    case "boolean":
    case "comparison":
      collectPredicatePaths(predicate.left, result);
      collectPredicatePaths(predicate.right, result);
      break;
    case "literal":
      break;
  }
}

export function parsePieceGetFilter(source: string): ParsedPieceGetFilter {
  if (source.trim().length === 0) {
    throw new PieceGetTransformError("--filter predicate must not be empty");
  }
  const predicate = new PredicateParser(
    source,
    tokenizePredicate(source),
  ).parse();
  const paths: Array<Array<string | number>> = [];
  collectPredicatePaths(predicate, paths);
  return { source, predicate, paths };
}

function valueAtPredicatePath(
  value: unknown,
  path: Array<string | number>,
): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined) return null;
    if (Array.isArray(current) && typeof segment === "number") {
      const index = segment < 0 ? current.length + segment : segment;
      current = index >= 0 && index < current.length ? current[index] : null;
      continue;
    }
    if (
      typeof current === "object" && !Array.isArray(current) &&
      typeof segment === "string"
    ) {
      current = Object.hasOwn(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : null;
      continue;
    }
    return null;
  }
  return current;
}

function predicateTruthiness(value: unknown): boolean {
  return value !== false && value != null;
}

function comparePredicateValues(
  operator: PredicateComparisonOperator,
  left: unknown,
  right: unknown,
): boolean {
  if (operator === "==") return deepEqual(left, right);
  if (operator === "!=") return !deepEqual(left, right);
  if (
    (typeof left !== "number" || typeof right !== "number") &&
    (typeof left !== "string" || typeof right !== "string")
  ) {
    throw new PieceGetTransformError(
      `--filter ${operator} requires two numbers or two strings`,
    );
  }
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}

export function evaluatePieceGetPredicate(
  predicate: PieceGetPredicate,
  value: unknown,
): boolean {
  const evaluate = (node: PieceGetPredicate): unknown => {
    switch (node.kind) {
      case "literal":
        return node.value;
      case "path":
        return valueAtPredicatePath(value, node.path);
      case "not":
        return !predicateTruthiness(evaluate(node.value));
      case "boolean": {
        const left = predicateTruthiness(evaluate(node.left));
        if (node.operator === "and") {
          return left && predicateTruthiness(evaluate(node.right));
        }
        return left || predicateTruthiness(evaluate(node.right));
      }
      case "comparison":
        return comparePredicateValues(
          node.operator,
          evaluate(node.left),
          evaluate(node.right),
        );
    }
  };
  return predicateTruthiness(evaluate(predicate));
}

const FORBIDDEN_PROJECTION_KEYS = new Set([
  "asCell",
  "default",
  "ifc",
  "scope",
]);
const UNSUPPORTED_PROJECTION_KEYS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "contains",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "contentSchema",
]);

function normalizeProjectionSchema(
  schema: unknown,
  path = "<root>",
): JSONSchema {
  if (schema === true) return true;
  if (schema === false) {
    throw new PieceGetTransformError(
      `Invalid --schema at ${path}: false cannot project a value`,
    );
  }
  if (!isRecord(schema) || Array.isArray(schema)) {
    throw new PieceGetTransformError(
      `Invalid --schema at ${path}: expected a JSON Schema object`,
    );
  }
  for (const key of Object.keys(schema)) {
    if (FORBIDDEN_PROJECTION_KEYS.has(key)) {
      throw new PieceGetTransformError(
        `Invalid --schema at ${path}: "${key}" is controlled by the source ` +
          "schema and cannot be supplied by a projection",
      );
    }
    if (UNSUPPORTED_PROJECTION_KEYS.has(key)) {
      throw new PieceGetTransformError(
        `Invalid --schema at ${path}: "${key}" is not supported by projection schemas`,
      );
    }
  }

  const result: Record<string, unknown> = { ...schema };
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties) || Array.isArray(schema.properties)) {
      throw new PieceGetTransformError(
        `Invalid --schema at ${path}: "properties" must be an object`,
      );
    }
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        normalizeProjectionSchema(child, `${path}.${key}`),
      ]),
    );
    if (schema.additionalProperties === undefined) {
      result.additionalProperties = false;
    }
  } else if (
    schemaTypes(schema as JSONSchema).includes("object") &&
    schema.additionalProperties === undefined
  ) {
    result.additionalProperties = true;
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    result.additionalProperties = normalizeProjectionSchema(
      schema.additionalProperties,
      `${path}.*`,
    );
  }
  if (schema.items !== undefined) {
    result.items = normalizeProjectionSchema(schema.items, `${path}[]`);
  }
  return result as JSONSchema;
}

function conciseProjectionSchema(source: string): JSONSchema {
  const paths = source.split(",").map((part) => part.trim());
  if (paths.some((path) => path.length === 0)) {
    throw new PieceGetTransformError(
      "Invalid --schema concise projection: expected comma-separated field paths",
    );
  }
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    const segments = path.split(".");
    if (
      segments.some((segment) => !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(segment))
    ) {
      throw new PieceGetTransformError(
        `Invalid --schema field path ${JSON.stringify(path)}`,
      );
    }
    let node = root;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (index === segments.length - 1) {
        node[segment] = true;
        continue;
      }
      const existing = node[segment];
      if (existing === true) break;
      if (!isRecord(existing)) {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    }
  }

  const toSchema = (node: Record<string, unknown>): JSONSchema => ({
    type: "object",
    properties: Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        value === true ? true : toSchema(value as Record<string, unknown>),
      ]),
    ),
    additionalProperties: false,
  });
  return toSchema(root);
}

export interface ProjectionParseDependencies {
  readTextFile?: (path: string) => Promise<string>;
}

export async function parsePieceGetProjection(
  source: string,
  deps: ProjectionParseDependencies = {},
): Promise<PieceGetProjection> {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new PieceGetTransformError("--schema must not be empty");
  }

  if (trimmed.startsWith("@")) {
    const path = trimmed.slice(1);
    if (path.length === 0) {
      throw new PieceGetTransformError(
        "--schema @file requires a file path",
      );
    }
    let contents: string;
    try {
      contents = await (deps.readTextFile ?? Deno.readTextFile)(path);
    } catch (error) {
      throw new PieceGetTransformError(
        `Could not read --schema file "${path}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new PieceGetTransformError(
        `Invalid JSON in --schema file "${path}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return {
      source,
      schema: normalizeProjectionSchema(parsed),
      kind: "json",
    };
  }

  if (trimmed.startsWith("{") || trimmed === "true" || trimmed === "false") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new PieceGetTransformError(
        `Invalid JSON passed to --schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return {
      source,
      schema: normalizeProjectionSchema(parsed),
      kind: "json",
    };
  }

  return {
    source,
    schema: conciseProjectionSchema(trimmed),
    kind: "concise",
  };
}

function schemaTypes(schema: JSONSchema | undefined): string[] {
  if (!isRecord(schema)) return [];
  return Array.isArray(schema.type)
    ? schema.type.filter((value): value is string => typeof value === "string")
    : typeof schema.type === "string"
    ? [schema.type]
    : [];
}

function schemaIsArray(schema: JSONSchema | undefined): boolean {
  return schemaTypes(schema).includes("array");
}

type SchemaRootKind = "array" | "non-array" | "unknown";

interface SchemaRootWalkBehavior<T> {
  unknown: T;
  fromTypes: (types: string[]) => T;
  fromAlternatives: (values: T[]) => T;
  fromAllOf: (values: T[]) => T;
  unresolvedRef: (error: unknown) => T;
}

function walkSchemaRoot<T>(
  schema: JSONSchema | undefined,
  behavior: SchemaRootWalkBehavior<T>,
  root: JSONSchema = schema ?? true,
  ancestors = new Set<object>(),
): T {
  if (!isRecord(schema) || ancestors.has(schema)) return behavior.unknown;
  ancestors.add(schema);
  const documentRoot = schema.$defs !== undefined ? schema : root;
  try {
    // A reference is the source shape for this heuristic. Resolve it before
    // inspecting sibling keywords so a broken reference cannot lend false
    // shape authority through, for example, a sibling `type`.
    if (schema.$ref !== undefined) {
      try {
        return walkSchemaRoot(
          ContextualFlowControl.resolveSchemaRefsOrThrow(
            schema,
            documentRoot,
          ),
          behavior,
          documentRoot,
          ancestors,
        );
      } catch (error) {
        return behavior.unresolvedRef(error);
      }
    }

    const types = schemaTypes(schema);
    // An explicit `type` is the authoritative root-shape signal here.
    // Combinators are conjunctive with it, so contradictory branch types
    // cannot expand the root shapes it declares.
    if (types.length > 0) return behavior.fromTypes(types);

    const alternatives = [...schema.anyOf ?? [], ...schema.oneOf ?? []];
    if (alternatives.length > 0) {
      return behavior.fromAlternatives(
        alternatives.map((option) =>
          walkSchemaRoot(option, behavior, documentRoot, ancestors)
        ),
      );
    }

    if (schema.allOf !== undefined) {
      return behavior.fromAllOf(
        schema.allOf.map((option) =>
          walkSchemaRoot(option, behavior, documentRoot, ancestors)
        ),
      );
    }
    return behavior.unknown;
  } finally {
    ancestors.delete(schema);
  }
}

/**
 * Classify a root container only when the declared schema makes its shape
 * unambiguous. This is intentionally conservative: an unknown shape falls
 * back to inspecting the value so schema-less and union-shaped cells retain
 * their existing projection semantics.
 *
 * @internal Exported for focused root-shape tests.
 */
export function schemaRootKind(
  schema: JSONSchema | undefined,
  root: JSONSchema = schema ?? true,
  ancestors = new Set<object>(),
): SchemaRootKind {
  return walkSchemaRoot(
    schema,
    {
      unknown: "unknown",
      fromTypes: (types) => {
        const hasArray = types.includes("array");
        if (!hasArray) return "non-array";
        return types.every((type) => type === "array") ? "array" : "unknown";
      },
      fromAlternatives: (kinds) => {
        const first = kinds[0];
        return first !== "unknown" && kinds.every((kind) => kind === first)
          ? first
          : "unknown";
      },
      fromAllOf: (values) => {
        const kinds = new Set(
          values.filter((kind) => kind !== "unknown"),
        );
        return kinds.size === 1 ? [...kinds][0] : "unknown";
      },
      // Root classification is an optimization only. A broken reference must
      // not prevent the existing value-shaped fallback from reporting the
      // source schema problem through the normal projection path.
      unresolvedRef: () => "unknown",
    },
    root,
    ancestors,
  );
}

function schemaAtArrayItem(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (schema === undefined) return undefined;
  const item = ContextualFlowControl.schemaAtPath(schema, ["0"]);
  return item === false ? undefined : item;
}

function dereferencedElementSchema(
  schema: JSONSchema | undefined,
): JSONSchema {
  if (!isRecord(schema) || schema.asCell === undefined) {
    return schema ?? true;
  }
  const { asCell: _asCell, ...dereferenced } = schema;
  return Object.keys(dereferenced).length === 0 ? true : dereferenced;
}

function filteredOutputSchema(
  sourceSchema: JSONSchema | undefined,
  outputItemSchema: JSONSchema | undefined,
): JSONSchema {
  if (!isRecord(sourceSchema)) {
    return { type: "array", items: true };
  }
  const { items: _items, prefixItems: _prefixItems, ...metadata } =
    sourceSchema;
  return {
    ...metadata,
    type: "array",
    items: dereferencedElementSchema(outputItemSchema),
  };
}

interface ObjectMask<Child> {
  type: "object";
  properties: Record<string, Child>;
  additionalProperties: false;
}
interface ArrayProjectionMask {
  type: "array";
  items: ProjectionMask;
}
interface ObjectProjectionMask extends ObjectMask<ProjectionMask> {}
type ProjectionMask =
  | true
  | ArrayProjectionMask
  | ObjectProjectionMask;
interface ObjectPredicateMask extends ObjectMask<PredicateMask> {}
type PredicateMask = true | ObjectPredicateMask;

function projectionMask(schema: JSONSchema): ProjectionMask {
  if (schema === true) return true;
  // `normalizeProjectionSchema()` rejects false schemas before this point.
  const objectSchema = schema as Exclude<JSONSchema, boolean>;
  if (
    objectSchema.additionalProperties === true ||
    isRecord(objectSchema.additionalProperties)
  ) {
    return true;
  }
  if (objectSchema.type === "array" || objectSchema.items !== undefined) {
    return {
      type: "array",
      items: objectSchema.items === undefined
        ? true
        : projectionMask(objectSchema.items),
    };
  }
  if (
    objectSchema.type === "object" || objectSchema.properties !== undefined
  ) {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(objectSchema.properties ?? {}).map(([key, child]) => [
          key,
          projectionMask(child),
        ]),
      ),
      additionalProperties: false,
    };
  }
  return true;
}

function schemaFromProjectionMask(mask: ProjectionMask): JSONSchema {
  if (mask === true) return true;
  if (mask.type === "array") {
    return {
      type: "array",
      items: schemaFromProjectionMask(mask.items),
    };
  }
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(mask.properties).map(([key, child]) => [
        key,
        schemaFromProjectionMask(child),
      ]),
    ),
    additionalProperties: false,
  };
}

/** @internal Exported for focused schema-shape tests. */
export function schemaMayBeArray(
  schema: JSONSchema | undefined,
  root: JSONSchema = schema ?? true,
  ancestors = new Set<object>(),
): boolean {
  return walkSchemaRoot(
    schema,
    {
      unknown: false,
      fromTypes: (types) => types.includes("array"),
      fromAlternatives: (values) => values.some(Boolean),
      fromAllOf: (values) => values.some(Boolean),
      // Unlike root classification, concise-path alignment cannot safely
      // continue without resolving the schema that determines array traversal.
      unresolvedRef: (error) => {
        throw new PieceGetTransformError(
          `Could not resolve source schema reference for --schema: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      },
    },
    root,
    ancestors,
  );
}

function alignConciseProjectionMask(
  source: JSONSchema | undefined,
  mask: ProjectionMask,
): ProjectionMask {
  if (mask === true || source === undefined || source === true) return mask;

  if (schemaMayBeArray(source)) {
    const sourceItem = schemaAtArrayItem(source);
    return {
      type: "array",
      items: alignConciseProjectionMask(sourceItem, mask),
    };
  }

  const objectMask = mask as ObjectProjectionMask;
  return {
    ...objectMask,
    properties: Object.fromEntries(
      Object.entries(objectMask.properties).map(([key, childMask]) => {
        const child = ContextualFlowControl.schemaAtPath(source, [key]);
        return [
          key,
          alignConciseProjectionMask(
            child === false ? undefined : child,
            childMask,
          ),
        ];
      }),
    ),
  };
}

function projectValue(
  value: unknown,
  schema: JSONSchema,
  implicitArrayTraversal = false,
): unknown {
  if (typeof schema === "boolean") return schema ? value : undefined;
  if (value === null) return value;
  if (Array.isArray(value)) {
    const itemSchema = schema.items ??
      (implicitArrayTraversal ? schema : true);
    return value.map((item) =>
      projectValue(item, itemSchema, implicitArrayTraversal)
    );
  }
  if (!isRecord(value)) return value;
  if (implicitArrayTraversal && schema.items !== undefined) {
    return projectValue(value, schema.items, implicitArrayTraversal);
  }

  const properties = schema.properties ?? {};
  const projected: Record<string, unknown> = {};
  if (schema.additionalProperties !== false) {
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key] ?? schema.additionalProperties ??
        true;
      projected[key] = projectValue(
        child,
        childSchema,
        implicitArrayTraversal,
      );
    }
    return projected;
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (key in value) {
      projected[key] = projectValue(
        value[key],
        childSchema,
        implicitArrayTraversal,
      );
    }
  }
  return projected;
}

function maskFromPaths(
  paths: Array<Array<string | number>>,
): PredicateMask {
  if (paths.some((path) => path.length === 0)) return true;
  const build = (
    remaining: Array<Array<string | number>>,
  ): PredicateMask => {
    if (remaining.some((path) => path.length === 0)) return true;
    if (remaining.some(([head]) => typeof head === "number")) return true;
    const strings = new Map<string, Array<Array<string | number>>>();
    for (const path of remaining) {
      const [head, ...tail] = path;
      const key = head as string;
      const entries = strings.get(key) ?? [];
      entries.push(tail);
      strings.set(key, entries);
    }
    return {
      type: "object",
      properties: Object.fromEntries(
        [...strings].map(([key, children]) => [key, build(children)]),
      ),
      additionalProperties: false,
    };
  };
  return paths.length === 0 ? true : build(paths);
}

/** @internal Exported for focused mask-composition tests. */
export function mergeMasks(
  left: PredicateMask,
  right: ProjectionMask,
): ProjectionMask {
  if (left === true || right === true) return true;
  if (right.type === "array") {
    return {
      type: "array",
      items: mergeMasks(left, right.items),
    };
  }
  const properties: Record<string, ProjectionMask> = {};
  for (
    const key of new Set([
      ...Object.keys(left.properties),
      ...Object.keys(right.properties),
    ])
  ) {
    const leftChild = left.properties[key];
    const rightChild = right.properties[key];
    properties[key] = leftChild === undefined
      ? rightChild!
      : rightChild === undefined
      ? leftChild
      : mergeMasks(leftChild, rightChild);
  }
  return { type: "object", properties, additionalProperties: false };
}

/** @internal Exported for focused source-schema selection tests. */
export function selectSourceSchema(
  source: JSONSchema | undefined,
  mask: ProjectionMask,
  purpose: "source-read" | "projected-output" = "source-read",
): JSONSchema {
  // An absent/wildcard source schema cannot prove that a structural mask has
  // the same container shape as the current value. Keep that read permissive;
  // the materializing projector still applies the mask and drops siblings.
  if (source === undefined || source === true) return true;
  if (source === false || mask === true || !isRecord(mask)) {
    return source;
  }
  if (source.$ref !== undefined) {
    if (source.$ref.startsWith("#/") && source.$defs === undefined) {
      return source;
    }
    try {
      return selectSourceSchema(
        ContextualFlowControl.resolveSchemaRefsOrThrow(source, source),
        mask,
        purpose,
      );
    } catch {
      // A malformed or unsupported source reference is not projection's job
      // to reinterpret. Preserve the declared selector and let the runtime
      // report the underlying schema problem.
      return source;
    }
  }
  if (
    source.anyOf !== undefined || source.oneOf !== undefined ||
    source.allOf !== undefined
  ) {
    const {
      anyOf,
      oneOf,
      allOf,
      ...metadata
    } = source;
    if (purpose === "source-read") {
      // Projection can make formerly exclusive branches overlap or discard a
      // discriminator altogether. Keep the declared composition intact at the
      // read boundary; only the materialized output schema uses projected
      // (existential) branches.
      return source;
    }
    const projectOptions = (options: readonly JSONSchema[] | undefined) =>
      options?.map((option) => selectSourceSchema(option, mask, purpose));
    const projectedAnyOf = projectOptions(anyOf);
    const projectedOneOf = projectOptions(oneOf);
    const projectedAllOf = projectOptions(allOf);
    const conjunctions = [
      ...projectedAllOf ?? [],
      ...(projectedOneOf === undefined ? [] : [{ anyOf: projectedOneOf }]),
    ];
    return {
      ...metadata,
      ...(projectedAnyOf === undefined ? {} : { anyOf: projectedAnyOf }),
      ...(conjunctions.length === 0 ? {} : { allOf: conjunctions }),
    };
  }

  if (mask.type === "array") {
    if (!schemaIsArray(source)) return source;
    const sourceItem = schemaAtArrayItem(source);
    const { items: _items, prefixItems: _prefixItems, ...metadata } = source;
    return {
      ...metadata,
      items: selectSourceSchema(sourceItem, mask.items, purpose),
    };
  }

  if (
    !schemaTypes(source).includes("object") &&
    source.properties === undefined
  ) {
    return source;
  }
  const {
    properties: _properties,
    required,
    additionalProperties: _additionalProperties,
    patternProperties: _patternProperties,
    ...metadata
  } = source;
  const properties: Record<string, JSONSchema> = {};
  for (const [key, childMask] of Object.entries(mask.properties)) {
    const child = ContextualFlowControl.schemaAtPath(source, [key]);
    properties[key] = selectSourceSchema(
      child === false ? undefined : child,
      childMask,
      purpose,
    );
  }
  const selectedRequired = required?.filter((key) => key in properties);
  return {
    ...metadata,
    properties,
    ...(selectedRequired?.length ? { required: selectedRequired } : {}),
    additionalProperties: false,
  };
}

interface ResolvedProjection {
  outputSchema: JSONSchema;
  projectionSchema: JSONSchema;
  mask: ProjectionMask;
  projectsArrayItems: boolean;
  itemOutputSchema?: JSONSchema;
  itemProjectionSchema?: JSONSchema;
  itemMask?: ProjectionMask;
  implicitArrayTraversal: boolean;
}

function resolveProjection(
  projection: PieceGetProjection | undefined,
  sourceSchema: JSONSchema | undefined,
  sourceIsArray: boolean,
): ResolvedProjection | undefined {
  if (projection === undefined) return undefined;
  if (projection.kind === "concise") {
    const projectsArrayItems = sourceIsArray;
    const source = projectsArrayItems
      ? schemaAtArrayItem(sourceSchema)
      : sourceSchema;
    const mask = alignConciseProjectionMask(
      source,
      projectionMask(projection.schema),
    );
    const projectionSchema = schemaFromProjectionMask(mask);
    const outputSchema = sanitizeSchemaForLinks(
      selectSourceSchema(
        dereferencedElementSchema(source),
        mask,
        "projected-output",
      ),
      KeepAsCell.OnlyStream,
    );
    return projectsArrayItems
      ? {
        outputSchema: filteredOutputSchema(sourceSchema, outputSchema),
        projectionSchema: {
          type: "array",
          items: projectionSchema,
        },
        mask: { type: "array", items: mask },
        projectsArrayItems: true,
        itemOutputSchema: outputSchema,
        itemProjectionSchema: projectionSchema,
        itemMask: mask,
        implicitArrayTraversal: true,
      }
      : {
        outputSchema,
        projectionSchema,
        mask,
        projectsArrayItems: false,
        implicitArrayTraversal: true,
      };
  }
  const projectsArrayItems = schemaIsArray(projection.schema);
  if (
    projection.schema !== true &&
    sourceIsArray !== projectsArrayItems
  ) {
    throw new PieceGetTransformError(
      sourceIsArray
        ? "A JSON --schema for an array value must describe the returned " +
          'array (for example {"type":"array","items":{...}}).'
        : "An array-rooted JSON --schema can only be applied to an array value.",
    );
  }
  const mask = projectionMask(projection.schema);
  const itemSchema = projectsArrayItems
    ? (projection.schema as Exclude<JSONSchema, boolean>).items ?? true
    : undefined;
  return {
    outputSchema: projection.schema,
    projectionSchema: projection.schema,
    mask,
    projectsArrayItems,
    implicitArrayTraversal: false,
    ...(projectsArrayItems
      ? {
        itemOutputSchema: itemSchema,
        itemProjectionSchema: itemSchema,
        itemMask: projectionMask(itemSchema!),
      }
      : {}),
  };
}

export interface DerivePieceGetDependencies {
  onOutputCell?: (cell: Cell<unknown>) => void;
}

/**
 * Apply a piece-get filter/projection through an actual runtime pattern graph.
 *
 * The filter uses the runner's list builtin, so predicate observations taint
 * collection membership exactly as they do in authored patterns. Array
 * projection uses the map builtin for pointwise labels. Object/scalar
 * projection uses a lift. Projection nodes construct the caller-requested
 * shape from source-schema-selected reads, preventing an identity alias from
 * widening back to a broader linked target. Caller schemas describe output
 * shape only; source schemas remain authoritative for CFC and other Fabric
 * metadata.
 */
export async function derivePieceGetValue(
  runtime: Runtime,
  space: MemorySpace,
  sourceCell: Cell<unknown>,
  transform: PieceGetTransform,
  deps: DerivePieceGetDependencies = {},
): Promise<unknown> {
  const declaredSourceSchema = sourceCell.schema;
  const sourceSchema = isRecord(declaredSourceSchema) &&
      declaredSourceSchema.asCell !== undefined
    ? dereferencedElementSchema(declaredSourceSchema)
    : declaredSourceSchema;
  const sourceValueCell = sourceSchema === declaredSourceSchema
    ? sourceCell
    : sourceCell.asSchema(sourceSchema);
  if (transform.filter === undefined && transform.projection === undefined) {
    return await sourceValueCell.pull();
  }

  const rootKind = schemaRootKind(sourceSchema);
  const sourceIsArray = rootKind === "unknown"
    ? Array.isArray(await sourceValueCell.pull())
    : rootKind === "array";
  if (transform.filter !== undefined && !sourceIsArray) {
    throw new PieceGetTransformError(
      "--filter can only be applied to an array",
    );
  }
  const projection = resolveProjection(
    transform.projection,
    sourceSchema,
    sourceIsArray,
  );
  const sourceItemSchema = schemaAtArrayItem(sourceSchema);
  const predicateItemMask = transform.filter === undefined
    ? undefined
    : maskFromPaths(transform.filter.paths);
  const projectionMaskSchema = projection?.mask;
  const projectionItemMask = projection?.itemMask;

  let sourceMask: ProjectionMask = true;
  if (transform.filter !== undefined && projection === undefined) {
    // Filtering returns original elements. Keep their complete source schema
    // on the links that survive, while the predicate pattern below narrows the
    // actual predicate reads.
    sourceMask = true;
  } else if (transform.filter !== undefined) {
    sourceMask = {
      type: "array",
      items: mergeMasks(
        predicateItemMask!,
        projectionItemMask!,
      ),
    };
  } else if (projectionMaskSchema !== undefined) {
    sourceMask = projectionMaskSchema;
  }
  const sourceReadSchema = selectSourceSchema(sourceSchema, sourceMask);

  const { commonfabric } = createBuilder({
    unsafeHostTrust: runtime.createUnsafeHostTrust({
      reason: "cf piece get filter/schema computed projection",
    }),
  });
  const { lift, pattern } = commonfabric;
  const paramsSchema: JSONSchema = {
    type: "object",
    additionalProperties: true,
  };

  let predicatePattern: ReturnType<typeof pattern> | undefined;
  if (transform.filter !== undefined) {
    const elementSchema = selectSourceSchema(
      sourceItemSchema,
      predicateItemMask!,
    );
    const argumentSchema: JSONSchema = {
      type: "object",
      properties: {
        element: sanitizeSchemaForLinks(
          dereferencedElementSchema(elementSchema),
          KeepAsCell.OnlyStream,
        ),
        params: paramsSchema,
      },
      required: ["element", "params"],
      additionalProperties: false,
    };
    const predicateModule = lift(
      ({ element, params }: {
        element: unknown;
        params: { predicate: PieceGetPredicate };
      }) => evaluatePieceGetPredicate(params.predicate, element),
      argumentSchema,
      { type: "boolean" },
    );
    predicatePattern = pattern(
      ({ element, params }: any) => predicateModule({ element, params }),
      argumentSchema,
      { type: "boolean" },
    );
  }

  let itemProjectionPattern: ReturnType<typeof pattern> | undefined;
  if (projection?.projectsArrayItems) {
    const itemOutputSchema = projection.itemOutputSchema!;
    const itemProjectionSchema = projection.itemProjectionSchema!;
    const elementSchema = selectSourceSchema(
      sourceItemSchema,
      projectionItemMask!,
    );
    const argumentSchema: JSONSchema = {
      type: "object",
      properties: {
        element: sanitizeSchemaForLinks(
          dereferencedElementSchema(elementSchema),
          KeepAsCell.OnlyStream,
        ),
      },
      required: ["element"],
      additionalProperties: false,
    };
    const projectionModule = lift(
      ({ element }: { element: unknown }) =>
        projectValue(
          element,
          itemProjectionSchema,
          projection.implicitArrayTraversal,
        ),
      argumentSchema,
      itemOutputSchema,
    );
    itemProjectionPattern = pattern(
      ({ element }: any) => projectionModule({ element }),
      argumentSchema,
      itemOutputSchema,
    );
  }

  const directProjectionArgumentSchema: JSONSchema = {
    type: "object",
    properties: {
      value: sanitizeSchemaForLinks(
        sourceReadSchema,
        KeepAsCell.OnlyStream,
      ),
    },
    required: ["value"],
    additionalProperties: false,
  };
  const directProjectionModule = projection !== undefined &&
      !projection.projectsArrayItems
    ? lift(
      ({ value }: { value: unknown }) =>
        projectValue(
          value,
          projection.projectionSchema,
          projection.implicitArrayTraversal,
        ),
      directProjectionArgumentSchema,
      projection.outputSchema,
    )
    : undefined;

  const outputSchema: JSONSchema = projection?.outputSchema ??
    filteredOutputSchema(sourceSchema, sourceItemSchema);
  const mainArgumentSchema: JSONSchema = {
    type: "object",
    properties: { value: sourceReadSchema },
    required: ["value"],
    additionalProperties: false,
  };
  const mainResultSchema: JSONSchema = {
    type: "object",
    properties: { value: outputSchema },
    required: ["value"],
    additionalProperties: false,
  };
  const mainPattern = pattern(
    ({ value }: any) => {
      let result: any = value;
      if (predicatePattern !== undefined) {
        result = result.filterWithPattern(predicatePattern as any, {
          predicate: transform.filter!.predicate,
        });
      }
      if (itemProjectionPattern !== undefined) {
        result = result.mapWithPattern(itemProjectionPattern as any, {});
      } else if (directProjectionModule !== undefined) {
        result = directProjectionModule({ value: result });
      }
      return { value: result };
    },
    mainArgumentSchema,
    mainResultSchema,
  );

  const tx = runtime.edit();
  const resultCell = runtime.getCell(
    space,
    {
      pieceGetTransform: {
        source: sourceValueCell.getAsNormalizedFullLink(),
        filter: transform.filter?.source,
        schema: transform.projection?.source,
      },
    },
    mainResultSchema,
    tx,
    "session",
  );
  const errors = runtimeErrorLog(runtime);
  const errorCountBefore = errors.length;
  const result = runtime.run(
    tx,
    mainPattern,
    {
      value: sourceValueCell.asSchema(sourceReadSchema).getAsLink({
        includeSchema: true,
        keepAsCell: KeepAsCell.OnlyStream,
      }),
    },
    resultCell,
  );
  // Computed results can return an alias whose target carries a broader (or
  // absent) schema. Re-assert the expression's declared result shape at the
  // read boundary so following that alias cannot widen the projection.
  const outputCell = result.key("value").asSchema(outputSchema);
  try {
    runtime.prepareTxForCommit(tx);
    const committed = await tx.commit();
    if (committed.error !== undefined) {
      throw new PieceGetTransformError(
        `Could not apply piece get transform: ${committed.error}`,
      );
    }
    await outputCell.pull();
    await runtime.idle();
    await runtime.storageManager.synced();
    await outputCell.pull();
    await runtime.idle();
    const outputValue = outputCell.get();
    const recorded = errors.slice(errorCountBefore);
    if (recorded.length > 0) {
      // Translate the array-shape errors emitted by the runner filter/map
      // builtins into CLI-level messages. Keep these matches in sync with
      // packages/runner/src/builtins/{filter,map}.ts; the mismatch regression
      // test in piece-get-transform.test.ts guards this package-boundary
      // coupling.
      if (
        transform.filter !== undefined &&
        recorded.some((error) =>
          error.message === "filter currently only supports arrays"
        )
      ) {
        throw new PieceGetTransformError(
          "--filter can only be applied to an array",
        );
      }
      if (
        projection?.projectsArrayItems &&
        recorded.some((error) =>
          error.message === "map currently only supports arrays"
        )
      ) {
        throw new PieceGetTransformError(
          "--schema can only project array items from an array value",
        );
      }
      const lastError = recorded.at(-1)!;
      throw new PieceGetTransformError(
        `Could not apply piece get transform: ${lastError.message}`,
      );
    }
    deps.onOutputCell?.(outputCell);
    return outputValue;
  } finally {
    runtime.runner.stop(resultCell);
  }
}
