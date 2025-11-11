/**
 * Factory function to create builder functions with runtime dependency injection
 */
import type {
  BuilderFunctionsAndConstants,
  ToSchemaFunction,
} from "./types.ts";
import {
  AsCell,
  AsComparableCell,
  AsOpaqueCell,
  AsReadonlyCell,
  AsStream,
  AsWriteonlyCell,
  AuthSchema,
  ID,
  ID_FIELD,
  isRecipe,
  NAME,
  schema,
  TYPE,
  UI,
} from "./types.ts";
import { h } from "@commontools/html";
import { recipe } from "./recipe.ts";
import { byRef, computed, derive, handler, lift } from "./module.ts";
import {
  compileAndRun,
  fetchData,
  generateObject,
  generateText,
  ifElse,
  llm,
  llmDialog,
  navigateTo,
  patternTool,
  str,
  streamData,
  wish,
} from "./built-in.ts";
import { cellConstructorFactory } from "../cell.ts";
import { getRecipeEnvironment } from "./env.ts";
import type { RuntimeProgram } from "../harness/types.ts";

// Runtime implementation of toSchema - this should never be called
// The TypeScript transformer should replace all calls at compile time
const toSchema: ToSchemaFunction = (_options?) => {
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
export const createBuilder = (): {
  commontools: BuilderFunctionsAndConstants;
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
} => {
  // Associate runtime programs with recipes after compilation and initial eval
  // and before compilation returns, so before any e.g. recipe would be
  // instantiated. This way they get saved with a way to rehydrate them.
  const exportsCallback = (exports: Map<any, RuntimeProgram>) => {
    for (const [value, program] of exports) {
      if (isRecipe(value)) {
        // This will associate the program with the recipe
        value.program = program;
      }
    }
  };

  return {
    commontools: {
      // Recipe creation
      recipe,
      patternTool,

      // Module creation
      lift,
      handler,
      derive,
      computed,

      // Built-in modules
      str,
      ifElse,
      llm,
      llmDialog,
      generateObject,
      generateText,
      fetchData,
      streamData,
      compileAndRun,
      navigateTo,
      wish,

      // Cell creation
      cell: cellConstructorFactory<AsCell>("cell").of,

      // Cell constructors with static methods
      Cell: cellConstructorFactory<AsCell>("cell"),
      OpaqueCell: cellConstructorFactory<AsOpaqueCell>("opaque"),
      Stream: cellConstructorFactory<AsStream>("stream"),
      ComparableCell: cellConstructorFactory<AsComparableCell>("comparable"),
      ReadonlyCell: cellConstructorFactory<AsReadonlyCell>("readonly"),
      WriteonlyCell: cellConstructorFactory<AsWriteonlyCell>("writeonly"),

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
