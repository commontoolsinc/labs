import { useEffect, useState } from "react";
import {
  Cell,
  effect,
  type JSONSchema,
  type MemorySpace,
  type Schema,
} from "@commontools/runner";
import { useRuntime } from "@/contexts/RuntimeContext.tsx";

export function useNamedCell<S extends JSONSchema>(
  space: MemorySpace,
  cause: any,
  schema: S,
): [Schema<S>, (newValue: Schema<S>) => void];
export function useNamedCell<T>(
  space: MemorySpace,
  cause: any,
  schema: JSONSchema,
): [T, (newValue: T) => void];
export function useNamedCell<T>(
  space: MemorySpace,
  cause: any,
  schema: JSONSchema,
) {
  const runtime = useRuntime();
  const cell = runtime.getCell<T>(space, cause, schema);
  cell.sync();

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

export function useCell<T>(
  cell: Cell<T> | null | undefined,
): [T | null | undefined, (value: T) => void] {
  const [value, setValue] = useState<T | null | undefined>(() => cell?.get());

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
      cell?.set(newValue);
    },
  ];
}
