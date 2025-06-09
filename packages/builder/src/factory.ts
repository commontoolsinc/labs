/**
 * Factory function to create builder functions with runtime dependency injection
 */

import type {
  BuilderFunctions,
  Cell,
  CreateCellFunction,
  JSONSchema,
} from "./types.ts";
import { opaqueRef, stream } from "./opaque-ref.ts";
import { getTopFrame, recipe } from "./recipe.ts";
import { byRef, compute, derive, handler, lift, render } from "./module.ts";
import {
  compileAndRun,
  fetchData,
  ifElse,
  llm,
  navigateTo,
  str,
  streamData,
} from "./built-in.ts";
import { getCellLinkOrThrow, type Runtime } from "@commontools/runner";
import { getRecipeEnvironment } from "./env.ts";

/**
 * Creates a set of builder functions with the given runtime
 * @param runtime - The runtime instance to use for cell creation
 * @returns An object containing all builder functions
 */
export const createBuilder = (
  runtime: Runtime,
): BuilderFunctions => {
  // Implementation of createCell moved from runner/harness
  const createCell: CreateCellFunction = function createCell<T = any>(
    schema?: JSONSchema,
    name?: string,
    value?: T,
  ): Cell<T> {
    const frame = getTopFrame();
    // This is a rather hacky way to get the context, based on the
    // unsafe_binding pattern. Once we replace that mechanism, let's add nicer
    // abstractions for context here as well.
    const cellLink = frame?.unsafe_binding?.materialize([]);
    if (!frame || !frame.cause || !cellLink) {
      throw new Error(
        "Can't invoke createCell outside of a lifted function or handler",
      );
    }
    if (!getCellLinkOrThrow) {
      throw new Error(
        "getCellLinkOrThrow function not provided to createBuilder",
      );
    }
    const space = getCellLinkOrThrow(cellLink).cell.space;

    const cause = { parent: frame.cause } as Record<string, any>;
    if (name) cause.name = name;
    else cause.number = frame.generatedIdCounter++;

    // Cast to Cell<T> is necessary to cast to interface-only Cell type
    const cell = runtime.getCell<T>(space, cause, schema) as Cell<T>;

    if (value !== undefined) cell.set(value);

    return cell;
  } as CreateCellFunction;

  return {
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
  };
};
