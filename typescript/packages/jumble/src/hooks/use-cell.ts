import { useEffect, useState } from "react";
import { JSONSchema } from "@commontools/builder";
import {
  Cell,
  type DocLink,
  effect,
  getDoc,
  getEntityId,
  idle,
  type Space,
  storage,
} from "@commontools/runner";
import { Identity } from "@commontools/identity";
export function useNamedCell<T>(
  defaultValue: T,
  cause: any,
  schema: JSONSchema,
  space: Space,
) {
  const doc = getDoc<T>(defaultValue, cause, space);
  const cell = doc.asCell([], undefined, schema);

  useEffect(() => {
    const syncCell = async () => {
      try {
        await storage.syncCell(cell);
        await idle();
      } catch (error) {
        console.error("Error syncing cell:", error);
      }
    };
    syncCell();
  }, [cell]);

  const [value, setValue] = useState<T>(cell.get());

  useEffect(() => {
    const cleanup = effect(cell, (newValue) => {
      setValue(newValue);
    });

    return cleanup;
  }, [cause, schema]);

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
