/**
 * Runtime globals for SES compartments.
 *
 * This module provides the globals that are available to patterns
 * running inside SES compartments.
 */

import type { RuntimeGlobals } from "./types.ts";
import { createBuilder } from "../builder/factory.ts";
import { createSandboxedConsole } from "./sandboxed-console.ts";
import { Temporal } from "temporal-polyfill";

// Declare harden as a global (added by SES lockdown)
declare const harden: <T>(obj: T) => T;

/**
 * Create the runtime globals object for a pattern compartment.
 *
 * This includes:
 * - CommonTools builders (recipe, pattern, lift, handler, etc.)
 * - Cell constructors
 * - Built-in modules
 * - Frozen standard JavaScript globals
 * - SES utilities (harden)
 *
 * @param patternId - The pattern ID for console prefixing
 * @param customConsole - Optional custom console to use
 * @returns The runtime globals object
 */
export function createRuntimeGlobals(
  patternId: string,
  customConsole?: Console,
): RuntimeGlobals {
  // Create the builder functions
  const { commontools } = createBuilder();

  // Create sandboxed console
  const sandboxedConsole = customConsole ??
    createSandboxedConsole({ patternId });

  // Build the globals object
  const globals: RuntimeGlobals = {
    // CommonTools builders
    recipe: harden(commontools.recipe),
    pattern: harden(commontools.pattern),
    patternTool: harden(commontools.patternTool),
    lift: harden(commontools.lift),
    handler: harden(commontools.handler),
    action: harden(commontools.action),
    derive: harden(commontools.derive),
    computed: harden(commontools.computed),

    // Cell constructors
    Cell: harden(commontools.Cell),
    Writable: harden(commontools.Writable),
    OpaqueCell: harden(commontools.OpaqueCell),
    Stream: harden(commontools.Stream),
    ComparableCell: harden(commontools.ComparableCell),
    ReadonlyCell: harden(commontools.ReadonlyCell),
    WriteonlyCell: harden(commontools.WriteonlyCell),
    cell: harden(commontools.cell),
    equals: harden(commontools.equals),

    // Built-in modules
    str: harden(commontools.str),
    ifElse: harden(commontools.ifElse),
    when: harden(commontools.when),
    unless: harden(commontools.unless),
    llm: harden(commontools.llm),
    llmDialog: harden(commontools.llmDialog),
    generateObject: harden(commontools.generateObject),
    generateText: harden(commontools.generateText),
    fetchData: harden(commontools.fetchData),
    fetchProgram: harden(commontools.fetchProgram),
    streamData: harden(commontools.streamData),
    compileAndRun: harden(commontools.compileAndRun),
    navigateTo: harden(commontools.navigateTo),
    wish: harden(commontools.wish),

    // Utilities
    byRef: harden(commontools.byRef),
    getRecipeEnvironment: harden(commontools.getRecipeEnvironment),
    getEntityId: harden(commontools.getEntityId),

    // Constants
    ID: commontools.ID,
    ID_FIELD: commontools.ID_FIELD,
    SELF: commontools.SELF,
    TYPE: commontools.TYPE,
    NAME: commontools.NAME,
    UI: commontools.UI,

    // Schema utilities
    schema: harden(commontools.schema),
    toSchema: harden(commontools.toSchema),
    AuthSchema: harden(commontools.AuthSchema),

    // Render utilities
    h: harden(commontools.h),

    // Sandboxed console
    console: sandboxedConsole,

    // Note: Standard JavaScript globals (JSON, Math, Date, Map, etc.) are
    // provided by SES intrinsics automatically. We don't need to pass them explicitly.
    //
    // Math.random() and Date.now() / new Date() will throw in the sandbox by default
    // to prevent non-determinism and fingerprinting.
    // Patterns must use secureRandom() and Temporal instead.

    // Global functions are also provided by SES (parseInt, isNaN, etc.)

    // Network access with deprecation warning
    // TODO(seefeld): Remove direct fetch access once patterns migrate to fetchData
    fetch: ((...args: Parameters<typeof fetch>) => {
      sandboxedConsole.warn(
        "Direct fetch() is deprecated. Rewrite as several steps in a pattern using fetchData() instead.",
      );
      return fetch(...args);
    }) as typeof fetch,

    // Temporal API (SES-safe replacement for Date.now() and new Date())
    Temporal: harden(Temporal),

    // SES-safe replacement for Math.random() — returns [0, 1) like Math.random()
    // TODO(seefeld): Replace with something that is seeded consistently,
    // e.g. with the current frame from handlers.
    secureRandom: () =>
      crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000,

    // SES-safe replacement for crypto.randomUUID()
    randomUUID: () => crypto.randomUUID(),

    // SES utility - harden is available after lockdown
    harden: typeof harden === "function" ? harden : Object.freeze,
  };

  return globals;
}

/**
 * Get a minimal set of globals for string evaluation.
 * This is used for evaluating small code snippets that don't need
 * the full CommonTools runtime.
 */
export function createMinimalGlobals(
  customConsole?: Console,
): Pick<
  RuntimeGlobals,
  | "console"
  | "harden"
> {
  return {
    console: customConsole ?? console,
    // Standard globals (JSON, Math, etc.) provided by SES
    harden: typeof harden === "function" ? harden : Object.freeze,
  };
}
