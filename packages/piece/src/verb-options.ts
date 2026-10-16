/**
 * A verb's options, read from the piece's state: the `x-options` annotation
 * on a property of a verb's event schema, resolved into a plain `enum`.
 *
 * The annotation names a path into the piece's result, as in `rings[].id`,
 * and optionally a second path naming each option's label, as in
 * `rings[].label` (`@options rings[].id rings[].label` in a pattern's JSDoc).
 * {@link resolveVerbOptions} reads those paths and writes what they hold
 * beside the annotation as `enum`, with the labels as `x-enum-labels`, so a
 * reader that knows nothing of the annotation sees an ordinary enumeration
 * and a reader that does can resolve it again.
 */

import type { JSONSchema } from "@commonfabric/api";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

/** One step of an options path: a property name, and whether the path steps
 * into each element of the array found there (`[]`). */
interface PathStep {
  name: string;
  each: boolean;
}

/** The annotation as a schema carries it. */
interface OptionsPaths {
  value: string;
  label?: string;
}

const isOptionsPaths = (value: unknown): value is OptionsPaths =>
  isObjectNotArray(value) && typeof value.value === "string" &&
  (value.label === undefined || typeof value.label === "string");

const parsePath = (path: string): PathStep[] =>
  path.split(".").map((step) =>
    step.endsWith("[]")
      ? { name: step.slice(0, -2), each: true }
      : { name: step, each: false }
  );

/** The values `steps` reaches from each of `from`. */
const follow = (from: unknown[], steps: readonly PathStep[]): unknown[] =>
  steps.reduce<unknown[]>(
    (values, step) =>
      values.flatMap((value) => {
        const found = isObjectNotArray(value) ? value[step.name] : undefined;
        if (!step.each) return [found];
        return Array.isArray(found) ? found : [];
      }),
    from,
  );

const sameStep = (left: PathStep, right: PathStep): boolean =>
  left.name === right.name && left.each === right.each;

/** An option is a value an `enum` can hold and a caller can type. */
const isOption = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" ||
  typeof value === "boolean";

/**
 * The options `paths` names in `result`, each beside its label when a label
 * path is given.
 *
 * Each option is the element of the last array the value path steps into, and
 * its label is read from that same element, so the label path has to step
 * through the same arrays first; a label path that does not names no labels.
 * A value repeated keeps its first label, and a value that is not a string,
 * number or boolean is not an option.
 */
function optionsAt(
  result: unknown,
  paths: OptionsPaths,
): { options: (string | number | boolean)[]; labels?: string[] } {
  const value = parsePath(paths.value);
  const lastEach = value.findLastIndex((step) => step.each);
  const prefix = value.slice(0, lastEach + 1);
  const label = paths.label === undefined ? undefined : parsePath(paths.label);
  const labelRest = label !== undefined && label.length > prefix.length &&
      prefix.every((step, index) => sameStep(step, label[index]))
    ? label.slice(prefix.length)
    : undefined;
  const options: (string | number | boolean)[] = [];
  const labels: string[] = [];
  for (const element of follow([result], prefix)) {
    const [option] = follow([element], value.slice(prefix.length));
    if (!isOption(option) || options.includes(option)) continue;
    options.push(option);
    if (labelRest !== undefined) {
      const [named] = follow([element], labelRest);
      labels.push(typeof named === "string" ? named : String(option));
    }
  }
  return labelRest === undefined ? { options } : { options, labels };
}

/** The schema keywords holding subschemas a property of an event sits under. */
const SCHEMA_MAP_KEYS = ["properties", "$defs", "patternProperties"] as const;
const SCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SCHEMA_KEYS = ["items", "additionalProperties", "not"] as const;

/** Every `x-options` annotation `schema` carries, at any depth. */
function annotationsIn(schema: unknown, found: OptionsPaths[] = []) {
  if (!isObjectNotArray(schema)) return found;
  if (isOptionsPaths(schema["x-options"])) found.push(schema["x-options"]);
  for (const key of SCHEMA_MAP_KEYS) {
    if (isObjectNotArray(schema[key])) {
      for (const child of Object.values(schema[key])) {
        annotationsIn(child, found);
      }
    }
  }
  for (const key of SCHEMA_LIST_KEYS) {
    if (Array.isArray(schema[key])) {
      for (const child of schema[key]) annotationsIn(child, found);
    }
  }
  for (const key of SCHEMA_KEYS) annotationsIn(schema[key], found);
  return found;
}

/** `schema` with each annotation in it resolved against `result`. */
function resolvedIn(schema: unknown, result: unknown): unknown {
  if (!isObjectNotArray(schema)) return schema;
  const next: Record<string, unknown> = { ...schema };
  const paths = schema["x-options"];
  if (isOptionsPaths(paths)) {
    const { options, labels } = optionsAt(result, paths);
    // An enum must name at least one value, so a state holding no options
    // leaves the property as the pattern declared it.
    if (options.length > 0) {
      next.enum = options;
      if (labels !== undefined) next["x-enum-labels"] = labels;
    }
  }
  for (const key of SCHEMA_MAP_KEYS) {
    if (isObjectNotArray(schema[key])) {
      next[key] = Object.fromEntries(
        Object.entries(schema[key]).map((
          [name, child],
        ) => [name, resolvedIn(child, result)]),
      );
    }
  }
  for (const key of SCHEMA_LIST_KEYS) {
    if (Array.isArray(schema[key])) {
      next[key] = schema[key].map((child) => resolvedIn(child, result));
    }
  }
  for (const key of SCHEMA_KEYS) {
    if (isObjectOrArray(schema[key])) {
      next[key] = resolvedIn(schema[key], result);
    }
  }
  return next;
}

/**
 * `schema` with every `x-options` annotation in it resolved against the
 * piece's state: an `enum` of the options the annotation's path holds, and
 * `x-enum-labels` beside it when the annotation names a label path, with the
 * annotation kept.
 *
 * `read` returns the value of one top-level property of the piece's result,
 * and is asked only for the properties the annotations' paths start at, so a
 * schema carrying no annotation is returned as it was, without a read.
 */
export async function resolveVerbOptions(
  schema: JSONSchema | true,
  read: (property: string) => Promise<unknown>,
): Promise<JSONSchema | true> {
  const annotations = annotationsIn(schema);
  if (annotations.length === 0) return schema;
  const names = new Set(
    annotations.flatMap((paths) =>
      [paths.value, paths.label].filter((path) => path !== undefined)
        .map((path) => parsePath(path)[0].name)
    ),
  );
  const result = Object.fromEntries(
    await Promise.all(
      [...names].map(async (name) => [name, await read(name)] as const),
    ),
  );
  return resolvedIn(schema, result) as JSONSchema;
}
