import { ConsoleMethod } from "./harness/console.ts";

export type ConsoleMessage = {
  metadata: { charmId?: string; recipeId?: string; space?: string } | undefined;
  method: ConsoleMethod;
  args: any[];
};
