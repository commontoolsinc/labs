import { useEffect, useState } from "react";
import { JSONSchema, Schema } from "@commontools/builder";
import {
  Cell,
  effect,
  getCell,
  type Space,
  storage,
} from "@commontools/runner";

export function useNamedCell<S extends JSONSchema>(
  cause: any,
  schema: S,
  space: Space,
): [Schema<S>, (newValue: Schema<S>) => void];
export function useNamedCell<T>(
  cause: any,
  schema: JSONSchema,
  space: Space,
): [T, (newValue: T) => void];
export function useNamedCell<T>(
  cause: any,
  schema: JSONSchema,
  space: Space,
) {
  const cell = getCell<T>(space, cause, schema);
  storage.syncCell(cell, true);

  const [value, setValue] = useState<T>(cell.get());

  useEffect(() => {
    const cleanup = effect(cell, (newValue) => {
      setValue(newValue);
    });

    return cleanup;
  }, [space, cause]);

  return [value, (newValue: T) => {
    cell.set(newValue);
  }] as const;
}

export function useCell<T>(cell: Cell<T>): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(cell.get());

  useEffect(() => {
    // Set up effect to update state when cell changes
    const cleanup = effect(cell, (newValue) => {
      setValue(newValue);
    });

    // Clean up effect when component unmounts or cell changes
    return cleanup;
  }, [cell]);

  // Return tuple of current value and setter function
  return [
    value,
    (newValue: T) => {
      cell.set(newValue);
    },
  ];
}
