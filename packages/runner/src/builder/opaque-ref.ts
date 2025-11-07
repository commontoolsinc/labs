import {
  type CellKind,
  type JSONSchema,
  type JSONValue,
  type Opaque,
  type OpaqueRef,
  type SchemaWithoutCell,
} from "./types.ts";
import { getTopFrame } from "./recipe.ts";
import { createCell } from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";

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
      "Can't create Cell-backed OpaqueRef without runtime in frame",
    );
  }

  // Initial value is treated as default value
  if (value !== undefined) {
    schema = {
      ...ContextualFlowControl.toSchemaObj(schema),
      default: value as JSONValue,
    };
  }

  // Create a Cell without a link - it will be created on demand via .for()
  // Use tx from frame if available
  const cell = createCell<T>(
    frame.runtime,
    {
      path: [],
      ...(schema !== undefined && { schema, rootSchema: schema }),
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
): OpaqueRef<T> {
  return opaqueRefWithCell<T>(undefined, schema, "stream");
}
