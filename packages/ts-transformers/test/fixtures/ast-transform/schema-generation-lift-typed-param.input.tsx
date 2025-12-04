/// <cts-enable />
import { lift } from "commontools";

// Lift requires explicit type annotation for proper schema generation
export const doubleValue = lift((value: number) => value * 2);
