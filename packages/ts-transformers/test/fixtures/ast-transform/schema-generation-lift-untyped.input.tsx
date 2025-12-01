/// <cts-enable />
import { lift } from "commontools";

// Testing schema generation when no type annotations are provided
// @ts-expect-error Testing untyped lift: value is unknown but transformer handles gracefully
export const doubleValue = lift((value) => value * 2);
