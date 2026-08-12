/**
 * The selection a CLI read applies to a cell it has already arrived at: the
 * `--filter` predicate and the `--select`/`--schema` projection, their parsers,
 * and the step that turns a cell plus a selection into a value. Resolving an
 * address to a cell belongs to whoever holds the address, and stays there.
 */

import type { Cell } from "@commonfabric/api";
import {
  ContextualFlowControl,
  createBuilder,
  deepEqual,
  type JSONSchema,
  KeepAsCell,
  type MemorySpace,
  type NormalizedFullLink,
  parseLink,
  type Runtime,
  sanitizeSchemaForLinks,
} from "@commonfabric/runner";
import { isRecord } from "@commonfabric/utils/types";
import { runtimeErrorLog } from "./callable.ts";

type PredicateComparisonOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** A parsed `--filter` expression, evaluated against one array element. */
export type SelectionPredicate =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "path"; path: Array<string | number> }
  | { kind: "not"; value: SelectionPredicate }
  | {
    kind: "boolean";
    operator: "and" | "or";
    left: SelectionPredicate;
    right: SelectionPredicate;
  }
  | {
    kind: "comparison";
    operator: PredicateComparisonOperator;
    left: SelectionPredicate;
    right: SelectionPredicate;
  };

/**
 * A `--filter` argument, parsed. `source` is the text as written, kept for
 * error messages and for the result cell's cause. `paths` collects every path
 * the predicate reads, which narrows the schema the source is read through.
 */
export interface ParsedSelectionFilter {
  source: string;
  predicate: SelectionPredicate;
  paths: Array<Array<string | number>>;
}

/** The key a caller writes beside `properties` to ask for an address. */
const LINK_MARKER_KEY = "$link";

/**
 * The character a concise field path ends a segment with to ask for the
 * address of the position that segment names. A backslash before it writes a
 * literal `@`, which a name needs only at the end of its segment: anywhere
 * else in a segment `@` is an ordinary character.
 */
const CONCISE_ADDRESS_SUFFIX = "@";

/**
 * The address a marked position renders, and the key it renders under. Every
 * field is present so a caller indexes it without branching: `id` keeps its
 * scheme, because the scheme is the kind and dropping it retargets the
 * address silently; `path` is `[]` at a document's root.
 *
 * The address names the deepest stored link crossed on the way to the marked
 * position, plus the segments below that link. A link is a durable identity
 * and a position in a containing document is not: reorder the collection
 * above it and the same position holds a different value.
 *
 * `overwrite` is dropped and `schema` is never inlined. A stored link can
 * carry an entire schema with its own `$defs`, and what was asked for is
 * where the value lives, not what shape it declares.
 */
export interface RenderedLinkAddress {
  id: NormalizedFullLink["id"];
  space: NormalizedFullLink["space"];
  scope: NormalizedFullLink["scope"];
  path: string[];
}

/**
 * The positions a projection marked for their address, mirroring the
 * projection's own shape. A node exists only where it, or something below it,
 * is marked.
 */
export interface LinkMarkers {
  /** The address at this position was asked for. */
  marked?: true;
  properties?: Record<string, LinkMarkers>;
  items?: LinkMarkers;
}

/**
 * The flag a projection was written on. `--select` takes the concise field
 * list; `--schema` takes a JSON Schema, an `@file`, and the concise list too.
 * Which one was written decides nothing about what the projection means — only
 * which flag its error messages name.
 */
export type ProjectionFlag = "--select" | "--schema";

/**
 * A projection argument, parsed. `source` is the text as written; `kind`
 * records which of the two spellings it used, since a concise field list
 * traverses arrays implicitly and a JSON Schema does not. `schema` carries no
 * `$link` marker: markers move to `markers`, and a position that asked for
 * nothing but an address becomes the `false` schema there.
 */
export interface SelectionProjection {
  source: string;
  schema: JSONSchema;
  kind: "concise" | "json";
  flag: ProjectionFlag;
  markers?: LinkMarkers;
}

/**
 * What a caller asked to be returned from the cell it selected. Both parts are
 * optional; a selection with neither returns the whole value.
 */
export interface CellSelection {
  filter?: ParsedSelectionFilter;
  projection?: SelectionProjection;
}

/**
 * A selection that cannot be parsed, or that does not fit the value it was
 * pointed at — a `--filter` on a non-array, a projection whose root shape
 * disagrees with the source. Reported to the user as a data error, not as an
 * argument-parsing failure.
 */
export class CellSelectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CellSelectionError";
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
  return new CellSelectionError(
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

  parse(): SelectionPredicate {
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

  #parseOr(): SelectionPredicate {
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

  #parseAnd(): SelectionPredicate {
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

  #parseComparison(): SelectionPredicate {
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

  #parseUnary(): SelectionPredicate {
    if (this.#takeKeyword("not")) {
      return { kind: "not", value: this.#parseUnary() };
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): SelectionPredicate {
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

  #parsePath(): SelectionPredicate {
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
  predicate: SelectionPredicate,
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

export function parseSelectionFilter(source: string): ParsedSelectionFilter {
  if (source.trim().length === 0) {
    throw new CellSelectionError("--filter predicate must not be empty");
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
    throw new CellSelectionError(
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

export function evaluateSelectionPredicate(
  predicate: SelectionPredicate,
  value: unknown,
): boolean {
  const evaluate = (node: SelectionPredicate): unknown => {
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

/**
 * The keywords that apply to exactly one container. Naming one says which
 * container the position describes, so the traversal that reads the projection
 * back needs no separate `type` from the caller.
 */
const OBJECT_PROJECTION_KEYS = [
  "properties",
  "additionalProperties",
  "required",
  "minProperties",
  "maxProperties",
];
const ARRAY_PROJECTION_KEYS = [
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
];

/**
 * The container a projection position describes but did not state. Schema
 * traversal descends `properties` only under `type: "object"` and `items` only
 * under `type: "array"`, so an omitted `type` silently empties the position —
 * and a nested position is where a caller omits it. Filling it in here keeps
 * that requirement out of what a caller has to know, and keeps traversal's
 * meaning of a stated type intact for every other reader.
 *
 * Arrays are tested first, matching {@link projectionMask}, so a position that
 * names both vocabularies reads as the array it named rather than disagreeing
 * with the selector built from it.
 */
function impliedProjectionType(
  declared: Record<string, unknown>,
): "object" | "array" | undefined {
  if (declared.type !== undefined) return undefined;
  if (ARRAY_PROJECTION_KEYS.some((key) => declared[key] !== undefined)) {
    return "array";
  }
  return OBJECT_PROJECTION_KEYS.some((key) => declared[key] !== undefined)
    ? "object"
    : undefined;
}

/** A projection schema with its `$link` markers lifted out of it. */
interface NormalizedProjectionSchema {
  schema: JSONSchema;
  markers?: LinkMarkers;
}

function normalizeProjectionSchema(
  schema: unknown,
  path = "<root>",
): NormalizedProjectionSchema {
  if (schema === true) return { schema: true };
  if (schema === false) {
    throw new CellSelectionError(
      `Invalid --schema at ${path}: false cannot project a value`,
    );
  }
  if (!isRecord(schema) || Array.isArray(schema)) {
    throw new CellSelectionError(
      `Invalid --schema at ${path}: expected a JSON Schema object`,
    );
  }
  for (const key of Object.keys(schema)) {
    if (key === LINK_MARKER_KEY) continue;
    if (FORBIDDEN_PROJECTION_KEYS.has(key)) {
      throw new CellSelectionError(
        `Invalid --schema at ${path}: "${key}" is controlled by the source ` +
          "schema and cannot be supplied by a projection",
      );
    }
    if (UNSUPPORTED_PROJECTION_KEYS.has(key)) {
      throw new CellSelectionError(
        `Invalid --schema at ${path}: "${key}" is not supported by projection schemas`,
      );
    }
  }
  const marker = schema[LINK_MARKER_KEY];
  if (marker !== undefined && marker !== true) {
    throw new CellSelectionError(
      `Invalid --schema at ${path}: "${LINK_MARKER_KEY}" must be \`true\``,
    );
  }

  const { [LINK_MARKER_KEY]: _marker, ...declared } = schema;
  const markers: LinkMarkers = marker === true ? { marked: true } : {};
  const implied = impliedProjectionType(declared);
  // An implied `type` leads the result, so a normalized schema reads the way a
  // caller would have written it out in full. A position that declared nothing
  // gains nothing: `{}` stays the wildcard it already is, and a bare marker
  // still reduces to `false` below.
  const result: Record<string, unknown> = implied === undefined
    ? { ...declared }
    : { type: implied, ...declared };
  if (declared.properties !== undefined) {
    if (!isRecord(declared.properties) || Array.isArray(declared.properties)) {
      throw new CellSelectionError(
        `Invalid --schema at ${path}: "properties" must be an object`,
      );
    }
    const properties: Record<string, JSONSchema> = {};
    const childMarkers: Record<string, LinkMarkers> = {};
    for (const [key, child] of Object.entries(declared.properties)) {
      const normalized = normalizeProjectionSchema(child, `${path}.${key}`);
      properties[key] = normalized.schema;
      if (normalized.markers !== undefined) {
        childMarkers[key] = normalized.markers;
      }
    }
    result.properties = properties;
    if (Object.keys(childMarkers).length > 0) markers.properties = childMarkers;
    if (declared.additionalProperties === undefined) {
      result.additionalProperties = false;
    }
  } else if (
    schemaTypes(result as JSONSchema).includes("object") &&
    declared.additionalProperties === undefined
  ) {
    result.additionalProperties = true;
  }
  if (
    declared.additionalProperties !== undefined &&
    typeof declared.additionalProperties !== "boolean"
  ) {
    const normalized = normalizeProjectionSchema(
      declared.additionalProperties,
      `${path}.*`,
    );
    // A marker names one position, and `additionalProperties` names a set
    // whose membership the stored value decides. Refuse rather than drop the
    // marker: dropping it answers with contents where an address was asked
    // for, which reads as a successful answer to a different question.
    if (normalized.markers !== undefined) {
      throw new CellSelectionError(
        `Invalid --schema at ${path}.*: "${LINK_MARKER_KEY}" is not ` +
          'supported under "additionalProperties"',
      );
    }
    result.additionalProperties = normalized.schema;
  }
  if (declared.items !== undefined) {
    const normalized = normalizeProjectionSchema(declared.items, `${path}[]`);
    result.items = normalized.schema;
    if (normalized.markers !== undefined) markers.items = normalized.markers;
  }
  // A position whose whole selection was its address reads nothing, and says
  // so with the rejecting schema. Everything downstream — the read selector,
  // the projector, the declared output shape — already means "nothing here"
  // by `false`, and the address is composed back in from the stored link.
  const reduced = marker === true && Object.keys(result).length === 0;
  return {
    schema: reduced ? false : result as JSONSchema,
    ...(Object.keys(markers).length > 0 ? { markers } : {}),
  };
}

/** A field name one concise path segment names, and what it asks for there. */
interface ConciseSegment {
  name: string;
  /** The segment ended in an unescaped {@link CONCISE_ADDRESS_SUFFIX}. */
  marked: boolean;
}

/**
 * The positions a concise field list names, as a tree. `whole` and `marked`
 * are separate questions about one position: `topic` asks for what is stored
 * there, `topic@` asks for its address, and a list naming both asks for both.
 */
interface ConciseSelection {
  whole: boolean;
  marked: boolean;
  properties: Map<string, ConciseSelection>;
}

/**
 * Helper for {@link conciseProjectionSchema}, which reads one dot-separated
 * segment of `path`. A trailing {@link CONCISE_ADDRESS_SUFFIX} asks for the
 * named position's address unless a backslash escapes it, and the character is
 * part of the name anywhere else: `user@home` names a field, and `a\@` names
 * the field `a@`.
 */
function parseConciseSegment(
  segment: string,
  path: string,
  flag: ProjectionFlag,
): ConciseSegment {
  const escaped = `\\${CONCISE_ADDRESS_SUFFIX}`;
  const marked = segment.endsWith(CONCISE_ADDRESS_SUFFIX) &&
    !segment.endsWith(escaped);
  const name = (marked ? segment.slice(0, -1) : segment)
    .replaceAll(escaped, CONCISE_ADDRESS_SUFFIX);
  if (!/^[A-Za-z_$][A-Za-z0-9_$@-]*$/.test(name)) {
    throw new CellSelectionError(
      `Invalid ${flag} field path ${JSON.stringify(path)}`,
    );
  }
  return { name, marked };
}

/**
 * Helper for {@link conciseProjectionSchema}, which constructs a position that
 * has named nothing yet.
 */
function emptyConciseSelection(): ConciseSelection {
  return { whole: false, marked: false, properties: new Map() };
}

/**
 * Helper for {@link conciseProjectionSchema}, which says whether `node` or
 * anything below it asked for an address.
 */
function conciseSelectionMarks(node: ConciseSelection): boolean {
  return node.marked ||
    [...node.properties.values()].some(conciseSelectionMarks);
}

/**
 * Helper for {@link conciseProjectionSchema}, which writes `node` out as the
 * projection schema it describes, `$link` markers included. Normalization
 * reads those markers back out, so a concise address suffix reaches the read
 * selector and the address composition the same way a written one does.
 */
function conciseSelectionSchema(node: ConciseSelection): unknown {
  const properties: Record<string, unknown> = {};
  for (const [name, child] of node.properties) {
    // A position asked for whole already answers every path through it, so a
    // deeper path adds something only where it asked for an address.
    if (node.whole && !conciseSelectionMarks(child)) continue;
    properties[name] = conciseSelectionSchema(child);
  }
  const named = Object.keys(properties).length > 0;
  const marker = node.marked ? { [LINK_MARKER_KEY]: true } : {};
  if (!node.whole) {
    // A position whose whole request was its address says exactly that, and
    // normalization reduces it to the rejecting schema.
    return named
      ? { ...marker, type: "object", properties, additionalProperties: false }
      : marker;
  }
  if (!named && !node.marked) return true;
  // `additionalProperties` keeps what a projection did not name, which is what
  // a bare path asks for at the position it ends on. `properties` is written
  // out beside it only to carry the markers below.
  return {
    ...marker,
    type: "object",
    ...(named ? { properties } : {}),
    additionalProperties: true,
  };
}

/**
 * Reads a comma-separated field list into the projection it describes. The
 * list names positions rather than shapes, so it is collected as a tree first:
 * the same position can be reached by several paths, and `topic@` beside
 * `topic.title` is one position asked two questions rather than two answers.
 *
 * A path that is nothing but {@link CONCISE_ADDRESS_SUFFIX} names the position
 * the read is already at, which no field path reaches because it is above
 * every field.
 */
function conciseProjectionSchema(
  source: string,
  flag: ProjectionFlag,
): NormalizedProjectionSchema {
  const paths = source.split(",").map((part) => part.trim());
  if (paths.some((path) => path.length === 0)) {
    throw new CellSelectionError(
      `Invalid ${flag} concise projection: expected comma-separated field paths`,
    );
  }
  const root = emptyConciseSelection();
  for (const path of paths) {
    if (path === CONCISE_ADDRESS_SUFFIX) {
      root.marked = true;
      continue;
    }
    const segments = path.split(".").map((segment) =>
      parseConciseSegment(segment, path, flag)
    );
    let node = root;
    for (const [index, segment] of segments.entries()) {
      let child = node.properties.get(segment.name);
      if (child === undefined) {
        child = emptyConciseSelection();
        node.properties.set(segment.name, child);
      }
      if (segment.marked) child.marked = true;
      if (index === segments.length - 1 && !segment.marked) child.whole = true;
      node = child;
    }
  }
  return normalizeProjectionSchema(conciseSelectionSchema(root));
}

export interface ProjectionParseDependencies {
  readTextFile?: (path: string) => Promise<string>;
}

/**
 * Parses a `--select` argument: the comma-separated field paths, which is the
 * whole of what this flag accepts. A path segment ending in
 * {@link CONCISE_ADDRESS_SUFFIX} asks for the address of the position it
 * names, and a path that is only the suffix asks the read's own source for
 * its address. `--schema` reads the same spelling and more, so an argument
 * written in the JSON Schema language is pointed at the flag that reads it
 * rather than reported as a malformed field path.
 *
 * `@file` names a schema file, which only `--schema` accepts, and a field name
 * cannot begin with `@`. A leading one is therefore an argument for the other
 * flag wherever it is not the bare suffix.
 */
export function parseSelectProjection(source: string): SelectionProjection {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new CellSelectionError("--select must not be empty");
  }
  const leading = trimmed.split(",", 1)[0].trim();
  if (
    trimmed.startsWith("{") || trimmed === "true" || trimmed === "false" ||
    (leading.startsWith(CONCISE_ADDRESS_SUFFIX) &&
      leading !== CONCISE_ADDRESS_SUFFIX)
  ) {
    throw new CellSelectionError(
      "--select takes comma-separated field paths. Pass a JSON Schema or an " +
        "@file to --schema instead.",
    );
  }
  return {
    source,
    ...conciseProjectionSchema(trimmed, "--select"),
    kind: "concise",
    flag: "--select",
  };
}

/**
 * Parses a `--schema` argument, which is written as a JSON Schema, as `@file`
 * naming one, or as the same comma-separated field paths `--select` takes.
 */
export async function parseSelectionProjection(
  source: string,
  deps: ProjectionParseDependencies = {},
): Promise<SelectionProjection> {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new CellSelectionError("--schema must not be empty");
  }

  if (trimmed.startsWith("@")) {
    const path = trimmed.slice(1);
    if (path.length === 0) {
      throw new CellSelectionError(
        "--schema @file requires a file path",
      );
    }
    let contents: string;
    try {
      contents = await (deps.readTextFile ?? Deno.readTextFile)(path);
    } catch (error) {
      throw new CellSelectionError(
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
      throw new CellSelectionError(
        `Invalid JSON in --schema file "${path}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return {
      source,
      ...normalizeProjectionSchema(parsed),
      kind: "json",
      flag: "--schema",
    };
  }

  if (trimmed.startsWith("{") || trimmed === "true" || trimmed === "false") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new CellSelectionError(
        `Invalid JSON passed to --schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return {
      source,
      ...normalizeProjectionSchema(parsed),
      kind: "json",
      flag: "--schema",
    };
  }

  return {
    source,
    ...conciseProjectionSchema(trimmed, "--schema"),
    kind: "concise",
    flag: "--schema",
  };
}

/**
 * Parses a command's `--filter` and projection arguments into the selection
 * they describe, or `undefined` when neither was given and the caller wants
 * the whole value. `select` and `schema` are two spellings of one projection,
 * and the commands that offer them declare the two flags conflicting, so at
 * most one arrives here; `select` is the one read when both do.
 */
export async function parseCellSelectionOptions(options: {
  filter?: string;
  schema?: string;
  select?: string;
}): Promise<CellSelection | undefined> {
  const filter = options.filter === undefined
    ? undefined
    : parseSelectionFilter(options.filter);
  const projection = options.select !== undefined
    ? parseSelectProjection(options.select)
    : options.schema === undefined
    ? undefined
    : await parseSelectionProjection(options.schema);
  return filter === undefined && projection === undefined
    ? undefined
    : { filter, projection };
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
/**
 * Which positions a selection reads. `false` is the rejecting one: the
 * position contributes nothing to the read, and the runner never loads what
 * is behind it.
 */
type ProjectionMask =
  | true
  | false
  | ArrayProjectionMask
  | ObjectProjectionMask;
interface ObjectPredicateMask extends ObjectMask<PredicateMask> {}
type PredicateMask = true | ObjectPredicateMask;

/**
 * The mask for an array whose elements `items` selects.
 *
 * An array whose elements are not read is not read. The rejecting selector has
 * to sit at the array itself to suppress the fetch: array traversal follows
 * each element's link before it consults the item schema, so a rejection one
 * level down arrives after the load it was meant to prevent.
 */
function arrayProjectionMask(items: ProjectionMask): ProjectionMask {
  return items === false ? false : { type: "array", items };
}

/**
 * The mask for an object whose named positions `properties` selects.
 *
 * An object whose every named position rejects is not read, by the same rule
 * {@link arrayProjectionMask} applies one level up: a rejection reaches the
 * fetch it suppresses only from the position that holds the link. Reducing
 * here is what carries a rejection below a link up to the array holding it, so
 * a marker below a link costs the same one read as a marker on it.
 *
 * Callers filter out the object that admits keys it does not name, which
 * cannot be narrowed and so is never all-rejecting. An object naming no
 * positions rejects nothing and stays a selector for the empty object it
 * describes.
 */
function objectProjectionMask(
  properties: Record<string, ProjectionMask>,
): ProjectionMask {
  const children = Object.values(properties);
  return children.length > 0 && children.every((child) => child === false)
    ? false
    : { type: "object", properties, additionalProperties: false };
}

function projectionMask(schema: JSONSchema): ProjectionMask {
  if (schema === true) return true;
  if (schema === false) return false;
  const objectSchema = schema as Exclude<JSONSchema, boolean>;
  if (objectSchema.type === "array" || objectSchema.items !== undefined) {
    return arrayProjectionMask(
      objectSchema.items === undefined
        ? true
        : projectionMask(objectSchema.items),
    );
  }
  // An object that admits keys it does not name cannot be narrowed: the
  // selector has to read whatever is there. The array branch above takes a
  // position that names both vocabularies, the same way
  // `impliedProjectionType()` types one: `additionalProperties` describes no
  // part of an array, and deciding an array position by it reads the whole
  // source over a keyword that says nothing about that position.
  if (
    objectSchema.additionalProperties === true ||
    isRecord(objectSchema.additionalProperties)
  ) {
    return true;
  }
  if (
    objectSchema.type === "object" || objectSchema.properties !== undefined
  ) {
    return objectProjectionMask(
      Object.fromEntries(
        Object.entries(objectSchema.properties ?? {}).map(([key, child]) => [
          key,
          projectionMask(child),
        ]),
      ),
    );
  }
  return true;
}

function schemaFromProjectionMask(mask: ProjectionMask): JSONSchema {
  if (typeof mask === "boolean") return mask;
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
  flag: ProjectionFlag = "--schema",
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
        throw new CellSelectionError(
          `Could not resolve source schema reference for ${flag}: ${
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
  flag: ProjectionFlag,
): ProjectionMask {
  if (
    typeof mask === "boolean" || source === undefined || source === true
  ) return mask;

  if (schemaMayBeArray(source, flag)) {
    const sourceItem = schemaAtArrayItem(source);
    return {
      type: "array",
      items: alignConciseProjectionMask(sourceItem, mask, flag),
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
            flag,
          ),
        ];
      }),
    ),
  };
}

/**
 * Aligns the markers a concise field list wrote against the shape the source
 * declares, the way {@link alignConciseProjectionMask} aligns the mask beside
 * them. A field list names a field wherever the value holds one rather than at
 * a fixed depth, so a name that crosses an array marks each of its elements:
 * the aligned markers say that with `items`, which is what a JSON Schema
 * states for itself. Where the source declares nothing the markers stay as
 * written, and the value the walk holds decides.
 */
function alignConciseMarkers(
  source: JSONSchema | undefined,
  markers: LinkMarkers,
  flag: ProjectionFlag,
): LinkMarkers {
  if (source === undefined || source === true) return markers;
  if (schemaMayBeArray(source, flag)) {
    return {
      items: alignConciseMarkers(schemaAtArrayItem(source), markers, flag),
    };
  }
  if (markers.properties === undefined) return markers;
  return {
    ...markers,
    properties: Object.fromEntries(
      Object.entries(markers.properties).map(([key, child]) => {
        const childSchema = ContextualFlowControl.schemaAtPath(source, [key]);
        return [
          key,
          alignConciseMarkers(
            childSchema === false ? undefined : childSchema,
            child,
            flag,
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
  // A union: a position the projection declines still has to be read when the
  // predicate observes it.
  if (right === false) return left;
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
  // A rejecting mask is the whole answer wherever it appears: nothing is read
  // at this position, whatever the source declares there.
  if (mask === false) return false;
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
  // A rejected position holds nothing to require. Keeping it required makes
  // the object unsatisfiable, which reads as an absent value for the whole
  // selection rather than for the one position that declined to be read.
  const selectedRequired = required?.filter((key) =>
    key in properties && properties[key] !== false
  );
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
  /** The projection's markers, at the depth the source puts them. */
  markers?: LinkMarkers;
}

function resolveProjection(
  projection: SelectionProjection | undefined,
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
      projection.flag,
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
    const markers = projection.markers === undefined
      ? undefined
      : alignConciseMarkers(source, projection.markers, projection.flag);
    return projectsArrayItems
      ? {
        outputSchema: filteredOutputSchema(sourceSchema, outputSchema),
        projectionSchema: {
          type: "array",
          items: projectionSchema,
        },
        // A field list read element-wise selects the array through its
        // elements, so an element the list rejects entirely rejects the array
        // the same way an item schema does.
        mask: arrayProjectionMask(mask),
        projectsArrayItems: true,
        itemOutputSchema: outputSchema,
        itemProjectionSchema: projectionSchema,
        itemMask: mask,
        implicitArrayTraversal: true,
        // An array source is read element-wise, and a field list marks what it
        // reads, so every marker below the root belongs to an element.
        ...(markers === undefined ? {} : { markers: { items: markers } }),
      }
      : {
        outputSchema,
        projectionSchema,
        mask,
        projectsArrayItems: false,
        implicitArrayTraversal: true,
        markers,
      };
  }
  const projectsArrayItems = schemaIsArray(projection.schema);
  if (
    projection.schema !== true &&
    sourceIsArray !== projectsArrayItems
  ) {
    throw new CellSelectionError(
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
    // A JSON Schema states its own depth, so its markers sit where it put them.
    markers: projection.markers,
    ...(projectsArrayItems
      ? {
        itemOutputSchema: itemSchema,
        itemProjectionSchema: itemSchema,
        itemMask: projectionMask(itemSchema!),
      }
      : {}),
  };
}

/**
 * A position the address walk has reached, and what a marker there renders.
 *
 * `address` is the deepest stored link the walk has crossed, plus the segments
 * below that link. `stored` is what the document containing this position
 * holds at it, and is absent below a crossed link: that link's target is a
 * document the walk does not read, so it can see no link stored inside it.
 */
interface WalkedPosition {
  cell: Cell<unknown>;
  address: RenderedLinkAddress;
  stored?: { value: unknown };
}

/** The address `link` names, in the shape a marked position renders. */
function renderedLinkAddress(link: NormalizedFullLink): RenderedLinkAddress {
  return {
    id: link.id,
    space: link.space,
    scope: link.scope,
    path: link.path.map((segment) => segment.toString()),
  };
}

/**
 * Helper for {@link composeLinkAddresses}: the position `cell` names, carrying
 * `address` from the walk above it unless the containing document stores a
 * link there. A stored link is a durable identity, so it becomes the address
 * this position renders and the base everything below it is addressed from.
 *
 * `space` and `scope` come from the containing document when the stored link
 * leaves them implicit, so both are always filled in.
 */
function walkedPosition(
  cell: Cell<unknown>,
  address: RenderedLinkAddress,
  stored: { value: unknown } | undefined,
): WalkedPosition {
  const link = stored === undefined
    ? undefined
    : parseLink(stored.value, address);
  return link === undefined
    ? { cell, address, stored }
    : { cell, address: renderedLinkAddress(link), stored: undefined };
}

/**
 * Helper for {@link composeLinkAddresses}: the position the walk reaches by
 * one more segment. `container` is what the document stores at the position
 * above, which is where the segment's own stored value comes from — so the
 * link a segment holds is read out of a document the selection already read,
 * rather than by following anything.
 */
function positionBelow(
  position: WalkedPosition,
  segment: string | number,
  container: unknown,
): WalkedPosition {
  const key = segment.toString();
  return walkedPosition(
    position.cell.key(key),
    { ...position.address, path: [...position.address.path, key] },
    isRecord(container) ? { value: container[key] } : undefined,
  );
}

/**
 * Helper for {@link composeLinkAddresses}: the position a composition starts
 * from, which is the cell the selection read. `lastNode: "top"` stops at a
 * link stored at that cell rather than following it, so a source that holds
 * one is addressed by it, exactly as any position below is.
 */
function sourcePosition(cell: Cell<unknown>): WalkedPosition {
  return walkedPosition(
    cell,
    renderedLinkAddress(cell.getAsNormalizedFullLink()),
    { value: cell.getRaw({ lastNode: "top" }) },
  );
}

/**
 * Helper for {@link composeLinkAddresses}, which reads the container stored at
 * `position` so a JSON `items` marker can be walked element by element.
 * Reaches for the container's own document when the walk cannot see the
 * container: behind a link, or where the selection's read stopped above it,
 * which is what a marked collection's rejecting selector does.
 */
async function storedContainer(position: WalkedPosition): Promise<unknown> {
  if (position.stored?.value !== undefined) return position.stored.value;
  const stored = position.cell.getRaw({ lastNode: "value" });
  if (stored !== undefined) return stored;
  await position.cell.asSchema(false).pull();
  return position.cell.getRaw({ lastNode: "value" });
}

/**
 * Helper for {@link composeLinkAddresses}: `markers` asked of every element of
 * `stored`, the array a position holds. Each element is addressed from the
 * link its own slot stores, so the answers survive a reordering of the
 * collection.
 */
async function composeElementAddresses(
  position: WalkedPosition,
  stored: readonly unknown[],
  markers: LinkMarkers,
  projected: unknown,
  implicitArrayTraversal: boolean,
): Promise<unknown[]> {
  const projectedItems = Array.isArray(projected) ? projected : [];
  const items: unknown[] = [];
  for (let index = 0; index < stored.length; index++) {
    items.push(
      await composeLinkAddresses(
        positionBelow(position, index, stored),
        markers,
        projectedItems[index],
        implicitArrayTraversal,
      ),
    );
  }
  return items;
}

/**
 * Composes the addresses a selection's markers asked for into `projected`, the
 * value its projection produced.
 *
 * A marked position renders `{"$link": <address>}`. Where the same position
 * also projected contents, the address joins them in one object, because both
 * were asked for. Where those contents are not an object there is nothing to
 * join them to, and the address is the whole answer.
 *
 * `implicitArrayTraversal` states that the markers came from a concise field
 * list, which names a field wherever the value holds one rather than at a
 * fixed depth. Where the source declares that depth,
 * {@link alignConciseMarkers} has already written it out as `items`, so
 * `notes@` answers with the note documents rather than with the slots they sit
 * in. Where the source declares nothing, the value decides instead: a position
 * the walk holds an array at is asked of each of its elements, the same way
 * {@link projectValue} applies one field mask across them, and the address
 * included. A JSON Schema states its own depth, and marks elements with
 * `items`.
 */
async function composeLinkAddresses(
  position: WalkedPosition,
  markers: LinkMarkers,
  projected: unknown,
  implicitArrayTraversal = false,
): Promise<unknown> {
  // The container is the one the walk already holds. A marked position is
  // never fetched, so below a crossed link there is nothing to look inside,
  // and that link is the address.
  const elements = implicitArrayTraversal && markers.items === undefined
    ? position.stored?.value
    : undefined;
  if (Array.isArray(elements)) {
    return await composeElementAddresses(
      position,
      elements,
      markers,
      projected,
      implicitArrayTraversal,
    );
  }

  let composed = projected;
  if (markers.items !== undefined) {
    const stored = await storedContainer(position);
    if (Array.isArray(stored)) {
      composed = await composeElementAddresses(
        position,
        stored,
        markers.items,
        projected,
        implicitArrayTraversal,
      );
    }
  } else if (markers.properties !== undefined) {
    const projectedRecord = isRecord(projected) && !Array.isArray(projected)
      ? projected
      : {};
    const record: Record<string, unknown> = { ...projectedRecord };
    for (const [key, child] of Object.entries(markers.properties)) {
      record[key] = await composeLinkAddresses(
        positionBelow(position, key, position.stored?.value),
        child,
        projectedRecord[key],
        implicitArrayTraversal,
      );
    }
    composed = record;
  }
  if (markers.marked !== true) return composed;
  const address = {
    [LINK_MARKER_KEY]: {
      ...position.address,
      path: [...position.address.path],
    },
  };
  return isRecord(composed) && !Array.isArray(composed)
    ? { ...address, ...composed }
    : address;
}

/** Optional hooks into {@link deriveSelectedValue}'s internals. */
export interface DeriveSelectedValueDependencies {
  /** Called with the cell the returned value was read from. */
  onOutputCell?: (cell: Cell<unknown>) => void;
}

/**
 * Applies `selection` to `sourceCell` through an actual runtime pattern graph,
 * returning the value the caller asked for.
 *
 * `runtime` and `space` say where that pattern runs, and are the caller's to
 * decide rather than the cell's: a path that crosses a link can land
 * `sourceCell` in a space other than the one its reader is working in.
 *
 * The filter uses the runner's list builtin, so predicate observations taint
 * collection membership exactly as they do in authored patterns. Array
 * projection uses the map builtin for pointwise labels. Object/scalar
 * projection uses a lift. Projection nodes construct the caller-requested
 * shape from source-schema-selected reads, preventing an identity alias from
 * widening back to a broader linked target. Caller schemas describe output
 * shape only; source schemas remain authoritative for CFC and other Fabric
 * metadata.
 *
 * A marker is answered beside that graph rather than through it: the marked
 * position contributes the rejecting selector to the read, so nothing behind
 * it is loaded, and its address is composed in from the deepest link the walk
 * down to it crosses, plus the segments below that link. That composition
 * walks the source, which a `--filter` makes unavailable — the elements a
 * predicate keeps cannot be traced back to the positions they came from — so
 * the two are refused together.
 */
export async function deriveSelectedValue(
  runtime: Runtime,
  space: MemorySpace,
  sourceCell: Cell<unknown>,
  selection: CellSelection,
  deps: DeriveSelectedValueDependencies = {},
): Promise<unknown> {
  const implicitArrayTraversal = selection.projection?.kind === "concise";
  if (
    selection.filter !== undefined &&
    selection.projection?.markers !== undefined
  ) {
    const asked = implicitArrayTraversal
      ? `an \`${CONCISE_ADDRESS_SUFFIX}\` suffix in ` +
        selection.projection!.flag
      : `a "${LINK_MARKER_KEY}" projection`;
    throw new CellSelectionError(
      `--filter cannot be combined with ${asked}: a filtered array's ` +
        "elements no longer say which positions they came from, and an " +
        "address names a position",
    );
  }
  const declaredSourceSchema = sourceCell.schema;
  const sourceSchema = isRecord(declaredSourceSchema) &&
      declaredSourceSchema.asCell !== undefined
    ? dereferencedElementSchema(declaredSourceSchema)
    : declaredSourceSchema;
  const sourceValueCell = sourceSchema === declaredSourceSchema
    ? sourceCell
    : sourceCell.asSchema(sourceSchema);
  if (selection.filter === undefined && selection.projection === undefined) {
    return await sourceValueCell.pull();
  }

  const rootKind = schemaRootKind(sourceSchema);
  const sourceIsArray = rootKind === "unknown"
    ? Array.isArray(await sourceValueCell.pull())
    : rootKind === "array";
  if (selection.filter !== undefined && !sourceIsArray) {
    throw new CellSelectionError(
      "--filter can only be applied to an array",
    );
  }
  const projection = resolveProjection(
    selection.projection,
    sourceSchema,
    sourceIsArray,
  );
  // The markers at the depth the source puts them, which is where the walk
  // below meets the positions they name.
  const markers = projection?.markers;
  if (markers !== undefined && projection?.mask === false) {
    // The whole selection was addresses. There is no value to compute, so the
    // pattern graph would run over the rejecting selector and produce nothing
    // for the composition to join. Read the stored links and answer.
    await sourceValueCell.asSchema(false).pull();
    return await composeLinkAddresses(
      sourcePosition(sourceValueCell),
      markers,
      undefined,
      implicitArrayTraversal,
    );
  }
  const sourceItemSchema = schemaAtArrayItem(sourceSchema);
  const predicateItemMask = selection.filter === undefined
    ? undefined
    : maskFromPaths(selection.filter.paths);
  const projectionMaskSchema = projection?.mask;
  const projectionItemMask = projection?.itemMask;

  let sourceMask: ProjectionMask = true;
  if (selection.filter !== undefined && projection === undefined) {
    // Filtering returns original elements. Keep their complete source schema
    // on the links that survive, while the predicate pattern below narrows the
    // actual predicate reads.
    sourceMask = true;
  } else if (selection.filter !== undefined) {
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
  if (selection.filter !== undefined) {
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
        params: { predicate: SelectionPredicate };
      }) => evaluateSelectionPredicate(params.predicate, element),
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
          predicate: selection.filter!.predicate,
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
        filter: selection.filter?.source,
        schema: selection.projection?.source,
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
      throw new CellSelectionError(
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
        selection.filter !== undefined &&
        recorded.some((error) =>
          error.message === "filter currently only supports arrays"
        )
      ) {
        throw new CellSelectionError(
          "--filter can only be applied to an array",
        );
      }
      if (
        projection?.projectsArrayItems &&
        recorded.some((error) =>
          error.message === "map currently only supports arrays"
        )
      ) {
        throw new CellSelectionError(
          `${selection.projection!.flag} can only project array items from ` +
            "an array value",
        );
      }
      const lastError = recorded.at(-1)!;
      throw new CellSelectionError(
        `Could not apply piece get transform: ${lastError.message}`,
      );
    }
    deps.onOutputCell?.(outputCell);
    return markers === undefined ? outputValue : await composeLinkAddresses(
      sourcePosition(sourceValueCell),
      markers,
      outputValue,
      implicitArrayTraversal,
    );
  } finally {
    runtime.runner.stop(resultCell);
  }
}
