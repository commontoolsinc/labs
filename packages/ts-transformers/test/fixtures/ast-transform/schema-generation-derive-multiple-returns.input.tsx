/// <cts-enable />
import { derive } from "commontools";

declare const flag: boolean;

// Function with multiple return statements - should infer string | number
export const multiReturn = derive(flag, (value) => {
  if (value) {
    return "hello";
  }
  return 42;
});