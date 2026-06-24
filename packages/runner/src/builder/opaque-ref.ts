import {
  type CellKind,
  type FactoryInput,
  type JSONSchema,
  type JSONValue,
  type OpaqueRef,
  type SchemaWithoutCell,
  type Stream,
} from "./types.ts";
import { getTopFrame } from "./pattern.ts";
import { createCell } from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";

/**
 * Implementation of opaqueRef that creates actual Cells.
 * Uses getTopFrame() to access the runtime.
 * @param value - Optional schema default value
 * @param schema - Optional schema
 * @returns An OpaqueRef
 */
function opaqueRefWithCell<T>(
  value?: FactoryInput<T> | T | undefined,
  schema?: JSONSchema,
  kind?: CellKind,
): OpaqueRef<T> {
  const frame = getTopFrame();
  if (!frame || !frame.runtime) {
    throw new Error(
      "Cannot create reactive reference - no runtime context available\n" +
        "help: create cells inside pattern/handler/lift contexts, or use plain objects for module-level constants",
    );
  }

  if (value !== undefined) {
    schema = {
      ...ContextualFlowControl.toSchemaObj(schema),
      default: defaultForValue(value),
    };
  }

  // Create a Cell without a link - it will be created on demand via .for()
  // Use tx from frame if available
  const cell = createCell<T>(
    frame.runtime,
    {
      path: [],
      ...(schema !== undefined && { schema }),
      ...(frame.space && { space: frame.space }),
    },
    frame.tx,
    false,
    kind,
  );

  frame.opaqueRefs.add(cell);

  // Use the cell's built-in method to get a proxied OpaqueRef
  return cell.getAsOpaqueRefProxy();
}

// Legacy opaqueRef for backward compatibility - creates proxies without Cell
// This is used during pattern construction before we have a runtime
export function opaqueRef<S extends JSONSchema>(
  value: FactoryInput<SchemaWithoutCell<S>> | SchemaWithoutCell<S> | undefined,
  schema: S,
): OpaqueRef<SchemaWithoutCell<S>>;
export function opaqueRef<T>(
  value?: FactoryInput<T> | T | undefined,
  schema?: JSONSchema,
): OpaqueRef<T>;

export function opaqueRef<T>(
  value?: FactoryInput<T> | T | undefined,
  schema?: JSONSchema,
): OpaqueRef<T> {
  return opaqueRefWithCell<T>(value, schema);
}

export function stream<T>(
  schema?: JSONSchema,
): Stream<T> {
  // The runtime creates a Stream cell, but opaqueRefWithCell is typed to return OpaqueRef
  return opaqueRefWithCell<T>(undefined, schema, "stream") as unknown as Stream<
    T
  >;
}

function defaultForValue(value: unknown): JSONValue {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function")
  ) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return toJSON.call(value) as JSONValue;
    }
  }
  return value as JSONValue;
}
