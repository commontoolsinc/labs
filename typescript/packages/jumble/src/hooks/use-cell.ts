import { useEffect, useState } from "react";
import { Cell, effect } from "@commontools/runner";

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
