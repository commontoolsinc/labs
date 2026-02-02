import {
  type CellKind,
  type JSONSchema,
  type Opaque,
  type OpaqueRef,
  type SchemaWithoutCell,
  type Stream,
} from "./types.ts";
import { getTopFrame } from "./recipe.ts";
import { createCell } from "../cell.ts";

/**
 * Implementation of opaqueRef that creates actual Cells.
 * Uses getTopFrame() to access the runtime.
 * @param value - Optional initial value
 * @param schema - Optional schema
 * @returns An OpaqueRef
 */
function opaqueRefWithCell<T>(
  value?: Opaque<T> | T,
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

  // Initial value is treated as default value

  // TODO(seefeld): Use this once default schemas are properly propagated
  /*
  if (value !== undefined) {
    schema = {
      ...ContextualFlowControl.toSchemaObj(schema),
      default: value as JSONValue,
    };
  }*/

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

  // TODO(seefeld): Remove once default schemas are properly propagated
  if (value !== undefined) {
    cell.setInitialValue(value as T);
  }

  frame.opaqueRefs.add(cell);

  // Use the cell's built-in method to get a proxied OpaqueRef
  return cell.getAsOpaqueRefProxy();
}

// Legacy opaqueRef for backward compatibility - creates proxies without Cell
// This is used during recipe construction before we have a runtime
export function opaqueRef<S extends JSONSchema>(
  value: Opaque<SchemaWithoutCell<S>> | SchemaWithoutCell<S>,
  schema: S,
): OpaqueRef<SchemaWithoutCell<S>>;
export function opaqueRef<T>(
  value?: Opaque<T> | T,
  schema?: JSONSchema,
): OpaqueRef<T>;

export function opaqueRef<T>(
  value?: Opaque<T> | T,
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
