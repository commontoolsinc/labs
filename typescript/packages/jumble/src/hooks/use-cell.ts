import { useEffect, useState } from "react";
import { DocImpl, effect } from "@commontools/runner";

export function useCell<T>(cell: DocImpl<T>): [T, (value: T) => void] {
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
      cell.asCell().set(newValue);
    },
  ];
}
