import {
  isOpaqueRefMarker,
  type JSONSchema,
  type NodeFactory,
  type NodeRef,
  type Opaque,
  type OpaqueRef,
  type Recipe,
  type SchemaWithoutCell,
  type ShadowRef,
} from "./types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { hasValueAtPath, setValueAtPath } from "../path-utils.ts";
import { getTopFrame, recipe } from "./recipe.ts";
import { createNodeFactory } from "./module.ts";
import { createCell } from "../cell.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";

let mapFactory: NodeFactory<any, any> | undefined;

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
): OpaqueRef<T> {
  const frame = getTopFrame();
  if (!frame || !frame.runtime) {
    throw new Error(
      "Can't create Cell-backed OpaqueRef without runtime in frame",
    );
  }

  // Create a Cell without a link - it will be created on demand via .for()
  // Use tx from frame if available
  const cell = createCell<T>(frame.runtime, undefined, frame.tx, false);

  // If schema provided, apply it
  if (schema) {
    cell.setSchema(schema);
  }

  // Set initial value if provided (cast to any to avoid type issues with Opaque)
  if (value !== undefined) {
    cell.set(value as any);
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
  // If we have a runtime in the frame, use Cell-backed OpaqueRef
  const frame = getTopFrame();
  if (!frame?.runtime) {
    throw new Error(
      "Can't create Cell-backed OpaqueRef without runtime in frame",
    );
  }

  return opaqueRefWithCell<T>(value, schema);
}

export function stream<T>(): OpaqueRef<T> {
  return opaqueRef<T>({ $stream: true } as T);
}
