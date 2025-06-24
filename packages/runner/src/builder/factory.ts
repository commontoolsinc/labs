/**
 * Factory function to create builder functions with runtime dependency injection
 */
import type {
  BuilderFunctionsAndConstants,
  Cell,
  CreateCellFunction,
  JSONSchema,
} from "./types.ts";
import {
  AuthSchema,
  h,
  ID,
  ID_FIELD,
  isRecipe,
  NAME,
  schema,
  TYPE,
  UI,
} from "./types.ts";
import { opaqueRef, stream } from "./opaque-ref.ts";
import { getTopFrame, recipe } from "./recipe.ts";
import { byRef, compute, derive, handler, lift, render } from "./module.ts";
import {
  compileAndRun,
  fetchData,
  generateObject,
  ifElse,
  llm,
  navigateTo,
  str,
  streamData,
} from "./built-in.ts";
import { getRecipeEnvironment } from "./env.ts";
import type { RuntimeProgram } from "../harness/types.ts";
import type { IRuntime } from "../runtime.ts";

// Runtime implementation of toSchema - this should never be called
// The TypeScript transformer should replace all calls at compile time
const toSchema = <T>(options?: Partial<JSONSchema>): JSONSchema => {
  throw new Error(
    "toSchema() should be transformed at compile time. " +
      "Make sure the TypeScript transformer is configured correctly.",
  );
};

/**
 * Creates a set of builder functions with the given runtime
 * @param runtime - The runtime instance to use for cell creation
 * @returns An object containing all builder functions
 */
export const createBuilder = (
  runtime: IRuntime,
): {
  commontools: BuilderFunctionsAndConstants;
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
} => {
  // Implementation of createCell moved from runner/harness
  const createCell: CreateCellFunction = function createCell<T = any>(
    schema?: JSONSchema,
    name?: string,
    value?: T,
  ): Cell<T> {
    const frame = getTopFrame();
    if (!frame || !frame.cause || !frame.unsafe_binding) {
      throw new Error(
        "Can't invoke createCell outside of a lifted function or handler",
      );
    }
    const space = frame.unsafe_binding.space;
    const tx = frame.unsafe_binding.tx;

    const cause = { parent: frame.cause } as Record<string, any>;
    if (name) cause.name = name;
    else cause.number = frame.generatedIdCounter++;

    // Cast to Cell<T> is necessary to cast to interface-only Cell type
    const cell = runtime.getCell<T>(space, cause, schema, tx) as Cell<T>;

    if (value !== undefined) cell.set(value);

    return cell;
  } as CreateCellFunction;

  // Associate runtime programs with recipes after compilation and initial eval
  // and before compilation returns, so before any e.g. recipe would be
  // instantiated. This way they get saved with a way to rehydrate them.
  const exportsCallback = (exports: Map<any, RuntimeProgram>) => {
    for (const [value, program] of exports) {
      if (isRecipe(value)) {
        // This will associate the program with the recipe
        runtime.recipeManager.registerRecipe(value, program);
      }
    }
  };

  return {
    commontools: {
      // Recipe creation
      recipe,

      // Module creation
      lift,
      handler,
      derive,
      compute,
      render,

      // Built-in modules
      str,
      ifElse,
      llm,
      generateObject,
      fetchData,
      streamData,
      compileAndRun,
      navigateTo,

      // Cell creation
      createCell,
      cell: opaqueRef,
      stream,

      // Utility
      byRef,

      // Environment
      getRecipeEnvironment,

      // Constants
      ID,
      ID_FIELD,
      TYPE,
      NAME,
      UI,

      // Schema utilities
      schema,
      toSchema,
      AuthSchema,

      // Render utils
      h,
    },
    exportsCallback,
  };
};
