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
    recipe: commontools.recipe,
    pattern: commontools.pattern,
    patternTool: commontools.patternTool,
    lift: commontools.lift,
    handler: commontools.handler,
    action: commontools.action,
    derive: commontools.derive,
    computed: commontools.computed,

    // Cell constructors
    Cell: commontools.Cell,
    Writable: commontools.Writable,
    OpaqueCell: commontools.OpaqueCell,
    Stream: commontools.Stream,
    ComparableCell: commontools.ComparableCell,
    ReadonlyCell: commontools.ReadonlyCell,
    WriteonlyCell: commontools.WriteonlyCell,
    cell: commontools.cell,
    equals: commontools.equals,

    // Built-in modules
    str: commontools.str,
    ifElse: commontools.ifElse,
    when: commontools.when,
    unless: commontools.unless,
    llm: commontools.llm,
    llmDialog: commontools.llmDialog,
    generateObject: commontools.generateObject,
    generateText: commontools.generateText,
    fetchData: commontools.fetchData,
    fetchProgram: commontools.fetchProgram,
    streamData: commontools.streamData,
    compileAndRun: commontools.compileAndRun,
    navigateTo: commontools.navigateTo,
    wish: commontools.wish,

    // Utilities
    byRef: commontools.byRef,
    getRecipeEnvironment: commontools.getRecipeEnvironment,
    getEntityId: commontools.getEntityId,

    // Constants
    ID: commontools.ID,
    ID_FIELD: commontools.ID_FIELD,
    SELF: commontools.SELF,
    TYPE: commontools.TYPE,
    NAME: commontools.NAME,
    UI: commontools.UI,

    // Schema utilities
    schema: commontools.schema,
    toSchema: commontools.toSchema,
    AuthSchema: commontools.AuthSchema,

    // Render utilities
    h: commontools.h,

    // Sandboxed console
    console: sandboxedConsole,

    // Standard JavaScript globals (frozen copies)
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    RegExp,
    Symbol,
    Proxy,
    Reflect,

    // TypedArrays
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    ArrayBuffer,
    DataView,

    // Global functions
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,

    // Network access with deprecation warning
    // TODO(seefeld): Remove direct fetch access once patterns migrate to fetchData
    fetch: ((...args: Parameters<typeof fetch>) => {
      sandboxedConsole.warn(
        "Direct fetch() is deprecated. Rewrite as several steps in a pattern using fetchData() instead.",
      );
      return fetch(...args);
    }) as typeof fetch,

    // Temporal API (SES-safe replacement for Date.now() and new Date())
    Temporal,

    // Web Crypto
    crypto,

    // SES-safe replacement for Math.random() — returns [0, 1) like Math.random()
    // TODO(seefeld): Replace with something that is seeded consistently,
    // e.g. with the current frame from handlers.
    secureRandom: () =>
      crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000,

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
  | "JSON"
  | "Math"
  | "Date"
  | "String"
  | "Number"
  | "Boolean"
  | "Array"
  | "Object"
  | "Map"
  | "Set"
  | "Promise"
  | "Error"
  | "harden"
> {
  return {
    console: customConsole ?? console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Promise,
    Error,
    harden: typeof harden === "function" ? harden : Object.freeze,
  };
}
