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
  CHIP_UI,
  FS,
  ID,
  ID_FIELD,
  NAME,
  schema as schemaIdentity,
  SELF,
  TILE_UI,
  TYPE,
  UI,
  WebhookConfigSchema,
} from "./types.ts";
import { h, UiAction, UiDisclosure, UiPromptSlot } from "@commonfabric/html";
import { pattern } from "./pattern.ts";
import { invokeFactory } from "./invoke-factory.ts";
import {
  action,
  assert,
  assertCapture,
  byRef,
  computed,
  handler,
  lift,
} from "./module.ts";
import {
  compileAndRun,
  fetchBinary,
  fetchJson,
  fetchJsonUnchecked,
  fetchProgram,
  fetchText,
  generateObject,
  generateText,
  ifElse,
  inspectConfLabel,
  llm,
  llmDialog,
  navigateTo,
  patternTool,
  sqliteDatabase,
  sqliteQuery,
  str,
  streamData,
  uiVariant,
  unless,
  when,
  wish,
} from "./built-in.ts";
import { cfLink, table } from "@commonfabric/memory/sqlite/schema";
import {
  all as rowLabelAll,
  any as rowLabelAny,
  authoredBy as rowLabelAuthoredBy,
  constant as rowLabelConstant,
  dbOwner as rowLabelDbOwner,
  endorsedBy as rowLabelEndorsedBy,
  intersect as rowLabelIntersect,
  match as rowLabelMatch,
  principal as rowLabelPrincipal,
  whenMatches as rowLabelWhenMatches,
} from "@commonfabric/memory/sqlite/row-label";
import { cellConstructorFactory } from "../cell.ts";
import { getEntityId } from "../create-ref.ts";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { getPatternEnvironment } from "./env.ts";
import type { RuntimeProgram } from "../harness/types.ts";
import { isTrustedPattern, setPatternProgram } from "./pattern-metadata.ts";
import {
  FabricInstance,
  FabricPrimitive,
} from "@commonfabric/data-model/fabric-value";
import {
  FabricEpochDays,
  FabricEpochNsec,
  FabricHash,
} from "@commonfabric/data-model/fabric-primitives";
import {
  toCompactDebugString,
  toIndentedDebugString,
} from "@commonfabric/data-model/value-debug";
import { freezeVerifiedPlainData } from "../sandbox/plain-data.ts";
import {
  registerUnsafeHostTrustedValue,
  type UnsafeHostTrust,
} from "../unsafe-host-trust.ts";

// Runtime implementation of toSchema - this should never be called
// The TypeScript transformer should replace all calls at compile time
const toSchema: ToSchemaFunction = (_options?) => {
  throw new Error(
    "toSchema() must be transformed at compile time - transformer not running\n" +
      "help: CTS transforms are enabled by default; remove /// <cf-disable-transform /> if present, or ensure you are using the Common Fabric build process",
  );
};

const runtimeSchema = freezeVerifiedPlainData as typeof schemaIdentity;

export interface CreateBuilderOptions {
  unsafeHostTrust?: UnsafeHostTrust;
}

/**
 * Creates a set of builder functions with the given runtime
 * @returns An object containing all builder functions
 */
export const createBuilder = (options: CreateBuilderOptions = {}): {
  commonfabric: BuilderFunctionsAndConstants;
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
} => {
  const trustValue = <T>(value: T): T => {
    registerUnsafeHostTrustedValue(options.unsafeHostTrust, value);
    return value;
  };

  const trustedPattern = ((...args: any[]) =>
    trustValue(
      (pattern as (...args: any[]) => unknown)(...args),
    )) as typeof pattern;
  const trustedLift = ((...args: any[]) =>
    trustValue(
      (lift as (...args: any[]) => unknown)(...args),
    )) as typeof lift;
  const trustedHandler = ((...args: any[]) =>
    trustValue(
      (handler as (...args: any[]) => unknown)(...args),
    )) as typeof handler;
  const trustedComputed = ((...args: any[]) =>
    trustValue(
      (computed as (...args: any[]) => unknown)(...args),
    )) as typeof computed;
  const trustedAssert = ((...args: any[]) =>
    trustValue(
      (assert as (...args: any[]) => unknown)(...args),
    )) as typeof assert;
  const trustedStr =
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      trustValue(str(strings, ...values))) as typeof str;
  const trustedPatternTool = ((...args: any[]) =>
    trustValue(
      (patternTool as (...args: any[]) => unknown)(...args),
    )) as typeof patternTool;

  // Associate runtime programs with patterns after compilation and initial eval
  // and before compilation returns, so before any e.g. pattern would be
  // instantiated. This way they get saved with a way to rehydrate them.
  const exportsCallback = (exports: Map<any, RuntimeProgram>) => {
    for (const [value, program] of exports) {
      // `isTrustedPattern` (not the structural `isPattern`): only a value the
      // trusted builder produced may acquire a rehydration program, so a
      // `__cf_data`-forged pattern-shaped export cannot launder trust metadata.
      if (isTrustedPattern(value)) {
        // Associate the program with the pattern via the side-table so it works
        // even when the exported pattern has been frozen by the loader.
        setPatternProgram(value, program);
      }
    }
  };

  const commonfabric = {
    // Pattern creation
    pattern: trustedPattern,
    patternTool: trustedPatternTool,

    // Module creation
    lift: trustedLift,
    handler: trustedHandler,
    action,
    computed: trustedComputed,
    assert: trustedAssert,

    // Operand recording for transformer-instrumented `assert` bodies. Plain
    // data in, plain data out — no builder artifact to trust.
    assertCapture,

    // Built-in modules
    str: trustedStr,
    ifElse,
    when,
    unless,
    uiVariant,
    llm,
    llmDialog,
    generateObject,
    generateText,
    fetchBinary,
    fetchText,
    fetchJson,
    fetchJsonUnchecked,
    fetchProgram,
    streamData,
    compileAndRun,
    sqliteDatabase,
    sqliteQuery,
    table,
    cfLink,
    // The SQLite helper namespace — one import for the growing vocabulary:
    // `const { table, all, principal, match, … } = cfSqlite`. The row-label
    // helpers (CFC Phase 3) live only here. There is deliberately no bare
    // `when`/`matches`: the builder's control-flow `when` lowering matches by
    // NAME and would mangle a local so named — the fused `whenMatches` avoids
    // the collision class entirely.
    cfSqlite: {
      table,
      cfLink,
      match: rowLabelMatch,
      principal: rowLabelPrincipal,
      all: rowLabelAll,
      any: rowLabelAny,
      intersect: rowLabelIntersect,
      whenMatches: rowLabelWhenMatches,
      dbOwner: rowLabelDbOwner,
      endorsedBy: rowLabelEndorsedBy,
      authoredBy: rowLabelAuthoredBy,
      constant: rowLabelConstant,
    },
    navigateTo,
    // inv-12 Stage 2: bounded first-layer label introspection (§4.6.4.1).
    inspectConfLabel,
    wish,

    // Multi-user test descriptor tag (see api MultiUserTestDescriptor):
    // identity at runtime; the call expression keeps the descriptor's pattern
    // factories out of module-level plain-data hardening.
    multiUserTest: <T>(descriptor: T): T => descriptor,

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
    invokeFactory,

    // Environment
    getPatternEnvironment,

    // Entity utilities
    getEntityId,
    entityRefToString,

    // Constants
    ID,
    ID_FIELD,
    SELF,
    TYPE,
    NAME,
    UI,
    TILE_UI,
    CHIP_UI,
    FS,

    // Schema utilities
    schema: runtimeSchema,
    toSchema,
    __cf_data: freezeVerifiedPlainData,
    AuthSchema,
    WebhookConfigSchema,

    // Render utils
    h,
    UiAction,
    UiPromptSlot,
    UiDisclosure,

    // Fabric value classes -- runtime values backing the type declarations
    // in api/index.ts. Enables `new FabricEpochNsec(...)` and `instanceof`
    // checks in patterns.
    FabricInstance,
    FabricPrimitive,
    FabricEpochNsec,
    FabricEpochDays,
    FabricHash,

    // Debug stringifiers (helpers exposed for pattern code)
    toCompactDebugString,
    toIndentedDebugString,
  } as BuilderFunctionsAndConstants & {
    __cfHelpers?: BuilderFunctionsAndConstants;
  };
  commonfabric.__cfHelpers = commonfabric;

  return {
    commonfabric,
    exportsCallback,
  };
};
