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
  isModule,
  isRecipe,
  NAME,
  schema,
  SELF,
  TYPE,
  UI,
} from "./types.ts";
import { h } from "@commontools/html";
import { pattern, recipe } from "./recipe.ts";
import { action, byRef, computed, derive, handler, lift } from "./module.ts";
import {
  compileAndRun,
  fetchData,
  fetchProgram,
  generateObject,
  generateText,
  ifElse,
  llm,
  llmDialog,
  navigateTo,
  patternTool,
  str,
  streamData,
  unless,
  when,
  wish,
} from "./built-in.ts";
import { cellConstructorFactory } from "../cell.ts";
import { getEntityId } from "../create-ref.ts";
import { getRecipeEnvironment } from "./env.ts";
import type { RuntimeProgram } from "../harness/types.ts";

// Runtime implementation of toSchema - this should never be called
// The TypeScript transformer should replace all calls at compile time
const toSchema: ToSchemaFunction = (_options?) => {
  throw new Error(
    "toSchema() must be transformed at compile time - transformer not running\n" +
      "help: enable CTS with /// <cts-enable /> directive, ensure using correct build process",
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
      } else if (isModule(value)) {
        // Associate the program with lift/handler/action modules
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
      action,
      derive,
      computed,

      // Built-in modules
      str,
      ifElse,
      when,
      unless,
      llm,
      llmDialog,
      generateObject,
      generateText,
      fetchData,
      fetchProgram,
      streamData,
      compileAndRun,
      navigateTo,
      wish,
      pattern,

      // Cell creation
      cell: cellConstructorFactory<AsCell>("cell").of,
      equals: cellConstructorFactory<AsCell>("cell").equals,

      // Cell constructors with static methods
      Cell: cellConstructorFactory<AsCell>("cell"),
      Writable: cellConstructorFactory<AsCell>("cell"), // Alias for Cell with clearer semantics
      OpaqueCell: cellConstructorFactory<AsOpaqueCell>("opaque"),
      Stream: cellConstructorFactory<AsStream>("stream"),
      ComparableCell: cellConstructorFactory<AsComparableCell>("comparable"),
      ReadonlyCell: cellConstructorFactory<AsReadonlyCell>("readonly"),
      WriteonlyCell: cellConstructorFactory<AsWriteonlyCell>("writeonly"),

      // Utility
      byRef,

      // Environment
      getRecipeEnvironment,

      // Entity utilities
      getEntityId,

      // Constants
      ID,
      ID_FIELD,
      SELF,
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
