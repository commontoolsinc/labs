import { ConsoleMethod } from "./harness/console.ts";

// Re-export storage types from memory package (canonical source)
export type {
  StorableArray,
  StorableDatum,
  StorableObject,
  StorableValue,
} from "@commontools/memory/interface";

export type ConsoleMessage = {
  metadata: { charmId?: string; recipeId?: string; space?: string } | undefined;
  method: ConsoleMethod;
  args: any[];
};
