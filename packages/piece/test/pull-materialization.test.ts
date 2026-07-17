import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  getPatternRepository,
  type JSONSchema,
  KeepAsCell,
  NAME,
  Pattern,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  entityRefToString,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import { defer } from "@commonfabric/utils/defer";
import {
  EmulatedStorageManager,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  validateAgainstSchema,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import { PieceManager } from "../src/manager.ts";
import {
  assertSuppliedLinkSchemasCompatible,
  assertWritablePiecePath,
  cellCapabilityCanNarrow,
  consumeOuterCellContract,
  consumeStreamEventContract,
  currentValuePathContracts,
  durableSourceContract,
  linkPathContracts,
  localizeOuterCellContract,
  localizeStreamEventContract,
  localizeWritableDestinationContracts,
  materializedValueAtPath,
  omitMissingProjectionAliases,
  PieceController,
  rawResolvedValueAtPath,
  resolveDeclaredStreamCapability,
  selectCurrentContainerSchema,
} from "../src/ops/piece-controller.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece pull materialization");

function doublePattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 2,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function tenfoldPattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 10,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function namedPattern(name: string, multiplier: number): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        [NAME]: { type: "string" },
        output: { type: "number" },
      },
      required: [NAME, "output"],
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      [NAME]: name,
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * multiplier,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function compiledMultiplierProgram(
  version: string,
  multiplier: number,
  main = "/main.tsx",
): RuntimeProgram {
  return {
    main,
    files: [
      {
        name: main,
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          `const multiply = lift((input: number) => input * ${multiplier});`,
          "export default pattern<{ input: number }>(({ input }) => ({",
          `  version: ${JSON.stringify(version)},`,
          "  output: multiply(input),",
          "}));",
        ].join("\n"),
      },
    ],
  };
}

function compiledSchemaEvolutionProgram(version: 1 | 2 | 3): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "interface Output { doubled: number; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "}));",
    ]
    : version === 2
    ? [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; }",
      "interface Input {",
      "  value: number;",
      "  label?: string;",
      "  retries: number | Default<0>;",
      "  options: Options;",
      "  mode?: string | number;",
      "}",
      "interface Output { doubled: number; summary?: string; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "  summary: 'updated',",
      "}));",
    ]
    : [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: string; }",
      "interface Output { doubled: string; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "}));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function compiledResultNarrowingProgram(
  resultType:
    | "string | number | boolean"
    | "string | number"
    | "string"
    | "number",
): RuntimeProgram {
  const value = resultType === "string" ? "String(input)" : "input";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "interface Input { input: number; }",
        `interface Output { value: ${resultType}; }`,
        "export default pattern<Input, Output>(({ input }) => ({",
        `  value: ${value},`,
        "}));",
      ].join("\n"),
    }],
  };
}

function compiledOptionalPartialDefaultProgram(
  version: 1 | 2,
): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ]
    : [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; name: string; }",
      "interface Input { value: number; options?: Options; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function compiledOptionalNumberFieldProgram(version: 1 | 2): RuntimeProgram {
  const input = version === 1
    ? "interface Input { value: number; }"
    : "interface Input { value: number; mode?: number; }";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        input,
        "export default pattern<Input>(({ value }) => ({ value }));",
      ].join("\n"),
    }],
  };
}

function compiledDefaultedOptionsProgram(version: 1 | 2): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ]
    : [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; }",
      "interface Input { value: number; options?: Options; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function compiledArrayItemDefaultsProgram(version: 1 | 2): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        `import { ${
          version === 1 ? "pattern" : "Default, pattern"
        } } from 'commonfabric';`,
        "interface Item {",
        "  mode?: string;",
        version === 2 ? "  attempts: number | Default<1>;" : "",
        "}",
        "interface Input { items: Item[]; }",
        "export default pattern<Input>(() => ({ ready: true }));",
      ].filter(Boolean).join("\n"),
    }],
  };
}

function compiledDynamicDefaultsProgram(version: 1 | 2): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        `import { ${
          version === 1 ? "pattern" : "Default, pattern"
        } } from 'commonfabric';`,
        "interface Item {",
        "  mode?: string;",
        version === 2 ? "  attempts: number | Default<1>;" : "",
        "}",
        "type Input = Record<string, Item>;",
        "export default pattern<Input>(() => ({ ready: true }));",
      ].filter(Boolean).join("\n"),
    }],
  };
}

function linkedSettingsSourcePattern(): Pattern {
  return {
    argumentSchema: { type: "object" },
    resultSchema: {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: { mode: { type: "string" } },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      required: ["settings"],
    },
    result: { settings: { mode: "linked" } },
    nodes: [],
  };
}

function compiledLinkedSettingsProgram(version: 1 | 2): RuntimeProgram {
  const attempts = version === 1 ? "" : "  attempts: number | Default<1>;";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        `import { ${
          version === 1 ? "pattern" : "Default, pattern"
        } } from 'commonfabric';`,
        "interface Settings {",
        "  mode: string;",
        attempts,
        "}",
        "interface Input { settings: Settings; }",
        "export default pattern<Input>(({ settings }) => ({",
        "  mode: settings.mode,",
        "}));",
      ].filter(Boolean).join("\n"),
    }],
  };
}

function trustPattern(runtime: Runtime, pattern: Pattern): Pattern {
  return runtime.unsafeTrustPattern(pattern, {
    reason: "piece pull materialization test fixture",
  });
}

// Two-replica harness: a server that several emulated replicas can share, so a
// fresh reader must fetch cross-replica rather than read its own warm cache.
// Mirrors newSharedServer/SharedServerStorageManager in
// fresh-replica-read-asymmetry.test.ts; the auth matches the server
// EmulatedStorageManager.emulate builds for itself (v2-emulate.ts).
const EMULATED_AUDIENCE = "did:key:z6Mk-runner-emulated-memory";

function newSharedServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: EMULATED_AUDIENCE },
  });
}

class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: { as: typeof signer },
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      // deno-lint-ignore no-explicit-any
      { ...options, memoryHost: new URL("memory://") } as any,
      () => server,
    );
    manager.#sharedServer = server;
    return manager;
  }
  #sharedServer!: MemoryV2Server.Server;
  protected override server(): MemoryV2Server.Server {
    return this.#sharedServer;
  }
}

describe("piece link contract localization", () => {
  const contract = (schema: JSONSchema, root: JSONSchema = schema) => ({
    schema,
    root,
  });

  it("never grants authority across the Cell capability lattice", () => {
    const kinds = [
      "cell",
      "readonly",
      "writeonly",
      "comparable",
      "opaque",
      "stream",
    ] as const;
    const allowed = new Set([
      "cell:cell",
      "cell:readonly",
      "cell:writeonly",
      "cell:comparable",
      "cell:opaque",
      "readonly:readonly",
      "readonly:comparable",
      "readonly:opaque",
      "writeonly:writeonly",
      "comparable:comparable",
      "opaque:opaque",
      "stream:stream",
    ]);

    for (const source of kinds) {
      for (const target of kinds) {
        expect(cellCapabilityCanNarrow(source, target)).toBe(
          allowed.has(`${source}:${target}`),
        );
      }
    }
  });

  it("fails closed for path ancestors that cannot be localized", () => {
    const unresolvedRoot: JSONSchema = { $defs: {} };
    expect(() =>
      linkPathContracts(
        [contract({ $ref: "#/$defs/Missing" }, unresolvedRoot)],
        [],
      )
    ).toThrow(/cannot resolve a local schema reference/);

    expect(linkPathContracts([contract(false)], ["child"])[0]?.schema)
      .toBe(false);
    expect(linkPathContracts([contract(true)], ["child"])[0]?.schema)
      .toBe(true);

    expect(() =>
      linkPathContracts(
        [contract({ type: "object", items: true })],
        ["child"],
      )
    ).toThrow(/ambiguous object\/array ancestor/);
    expect(() =>
      linkPathContracts(
        [contract({ type: "array", items: true })],
        ["not-an-index"],
      )
    ).toThrow(/array link path contains non-index segment/);

    expect(
      linkPathContracts([contract({ $defs: {} })], ["child"])[0]?.schema,
    ).toBe(true);
    expect(() =>
      linkPathContracts(
        [contract({ type: "number" })],
        ["child"],
      )
    ).toThrow(/schema does not describe a container/);
  });

  it("localizes tuple prefixItems before falling back to items", () => {
    const schema: JSONSchema = {
      type: "array",
      prefixItems: [{ $ref: "#/$defs/First" }],
      items: { type: "number" },
      $defs: { First: { type: "string" } },
    };

    expect(linkPathContracts([contract(schema)], [0])[0]?.schema).toEqual({
      type: "string",
    });
    expect(linkPathContracts([contract(schema)], [1])[0]?.schema).toEqual({
      type: "number",
    });
  });

  it("keeps sparse array indices optional despite minItems", () => {
    const schema: JSONSchema = {
      type: "array",
      prefixItems: [{ type: "number" }],
      items: { type: "number" },
      minItems: 1,
    };

    expect(
      linkPathContracts([contract(schema)], [0], {
        trackSourcePresence: true,
      })[0]?.schema,
    ).toEqual({
      anyOf: [{ type: "number" }, { type: "undefined" }],
    });
  });

  it("selects current container shapes and rejects impossible ones", () => {
    const scalar = { type: "number", maximum: 10 } as const;
    expect(selectCurrentContainerSchema(scalar, 1)).toBe(scalar);
    expect(() =>
      selectCurrentContainerSchema(
        { type: "array", items: true },
        { value: 1 },
      )
    ).toThrow(/not accepted as an object container/);

    expect(
      selectCurrentContainerSchema(
        {
          type: ["object", "array"],
          properties: { value: { type: "number" } },
          required: ["value"],
          items: { type: "number" },
          uniqueItems: true,
          maximum: 10,
          minLength: 1,
          dependentRequired: { value: ["other"] },
        },
        { value: 1 },
      ),
    ).toEqual({
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    });
  });

  it("localizes every selected current-value composition branch", () => {
    const anyOfSchema: JSONSchema = {
      anyOf: [{
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      }, {
        type: "object",
        properties: { value: { type: "number", minimum: 0 } },
        required: ["value"],
      }],
    };
    expect(
      currentValuePathContracts(
        contract(anyOfSchema),
        "value",
        { value: 1 },
        { value: 2 },
      ).map((entry) => entry.schema),
    ).toEqual([
      true,
      { type: "number" },
      { type: "number", minimum: 0 },
    ]);

    const oneOfSchema: JSONSchema = {
      oneOf: [{
        type: "object",
        properties: {
          kind: { const: "number" },
          value: { type: "number" },
        },
        required: ["kind", "value"],
      }, {
        type: "object",
        properties: {
          kind: { const: "string" },
          value: { type: "string" },
        },
        required: ["kind", "value"],
      }],
    };
    expect(
      currentValuePathContracts(
        contract(oneOfSchema),
        "value",
        { kind: "number", value: 1 },
        { kind: "string", value: "next" },
      ).map((entry) => entry.schema),
    ).toEqual([true, { type: "string" }, { type: "number" }]);

    const allOfSchema: JSONSchema = {
      allOf: [{
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      }, {
        type: "object",
        properties: { value: { type: "number", minimum: 0 } },
        required: ["value"],
      }],
    };
    expect(
      currentValuePathContracts(
        contract(allOfSchema),
        "value",
        { value: 1 },
        { value: 2 },
      ).map((entry) => entry.schema),
    ).toEqual([
      true,
      { type: "number" },
      { type: "number", minimum: 0 },
    ]);
    expect(() =>
      currentValuePathContracts(
        contract(allOfSchema),
        "value",
        { value: 1 },
        { value: -1 },
      )
    ).toThrow(/does not satisfy an allOf write contract/);
  });

  it("fails closed when current-value branch selection is not provable", () => {
    expect(() =>
      currentValuePathContracts(
        contract({ type: "number", dependentRequired: {} }),
        "value",
        1,
        2,
      )
    ).toThrow(/dependentRequired correlates/);

    expect(() =>
      currentValuePathContracts(
        contract({
          type: "array",
          anyOf: [{ type: "array", items: { type: "number" } }],
        }),
        0,
        [1],
        { value: 1 },
      )
    ).toThrow(/not accepted as an object container/);

    expect(() =>
      currentValuePathContracts(
        contract({
          dependentSchemas: { value: { required: ["other"] } },
          anyOf: [{ type: "object" }],
        }),
        "value",
        1,
        2,
      )
    ).toThrow(/dependentSchemas correlates/);

    expect(() =>
      currentValuePathContracts(
        contract({ allOf: [] }),
        "value",
        1,
        2,
      )
    ).toThrow(/allOf correlates/);

    expect(() =>
      currentValuePathContracts(
        contract({
          anyOf: [{
            type: "object",
            properties: { kind: { const: "known" } },
            required: ["kind"],
          }],
        }),
        "kind",
        { kind: "known" },
        { kind: "unknown" },
      )
    ).toThrow(/does not select a valid anyOf write contract/);

    const overlapping: JSONSchema = {
      oneOf: [{
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      }, {
        type: "object",
        properties: { value: { minimum: 0 } },
        required: ["value"],
      }],
    };
    expect(() =>
      currentValuePathContracts(
        contract(overlapping),
        "value",
        { value: 1 },
        { value: 2 },
      )
    ).toThrow(/does not select a valid oneOf write contract/);

    const recursive: JSONSchema = { anyOf: [{ type: "object" }] };
    const active = new WeakSet<object>();
    active.add(recursive as object);
    expect(() =>
      currentValuePathContracts(
        contract(recursive),
        "value",
        { value: 1 },
        { value: 2 },
        active,
      )
    ).toThrow(/recursive correlated write schema/);
  });

  it("localizes outer Cell compositions without erasing authority", () => {
    const readonly = { type: "number", asCell: ["readonly"] } as JSONSchema;
    const writeonly = {
      type: "number",
      asCell: ["writeonly"],
    } as JSONSchema;

    expect(
      localizeOuterCellContract(contract({
        anyOf: [readonly, writeonly],
      })).issue,
    ).toMatch(/incompatible outer capabilities/);

    expect(
      localizeOuterCellContract(
        contract({ anyOf: [readonly, { type: "number" }, { type: "string" }] }),
        { value: 1, opaqueHandle: false },
      ).contract.schema,
    ).toEqual({ anyOf: [{ type: "number" }, { type: "string" }] });

    expect(
      localizeOuterCellContract(contract({
        anyOf: [{ type: "number", asCell: ["stream"] }, true],
      })).issue,
    ).toMatch(/mixed stream and non-stream anyOf alternatives/);
    expect(
      localizeOuterCellContract(contract({ anyOf: [readonly, true] })).issue,
    ).toMatch(/ambiguous wrapped and unwrapped anyOf alternatives/);

    expect(
      localizeOuterCellContract(contract({
        allOf: [readonly, writeonly],
      })).issue,
    ).toMatch(/incompatible outer capabilities/);

    const recursiveAnyOf = {} as { anyOf?: JSONSchema[] };
    recursiveAnyOf.anyOf = [recursiveAnyOf as JSONSchema];
    expect(
      localizeOuterCellContract(
        contract(recursiveAnyOf as JSONSchema),
      ).issue,
    ).toMatch(/recursive Cell schema/);

    const recursiveAllOf = {} as { allOf?: JSONSchema[] };
    recursiveAllOf.allOf = [recursiveAllOf as JSONSchema];
    expect(
      localizeOuterCellContract(
        contract(recursiveAllOf as JSONSchema),
      ).issue,
    ).toMatch(/recursive Cell schema/);
  });

  it("consumes only well-formed outer Cell wrappers", () => {
    expect(consumeOuterCellContract(true)).toEqual({
      kind: "cell",
      payloadSchema: true,
    });
    expect(
      consumeOuterCellContract({
        type: "number",
        asCell: ["stream", "cell"],
      }),
    ).toEqual({
      kind: "stream",
      payloadSchema: { type: "number", asCell: ["cell"] },
    });
    expect(() =>
      consumeOuterCellContract({
        type: "number",
        asCell: [{}],
      } as unknown as JSONSchema)
    ).toThrow(/invalid outer Cell kind/);
  });

  it("fails closed for malformed stream-event compositions", () => {
    expect(() => consumeStreamEventContract(contract(true))).toThrow(
      /no stream-bearing alternative/,
    );

    const cellOnly = localizeStreamEventContract(
      contract({ type: "number", asCell: ["cell"] }),
    );
    expect(cellOnly.consumedStream).toBe(false);
    expect(cellOnly.issue).toMatch(/uses cell wrapper/);

    expect(() =>
      consumeStreamEventContract(contract({
        anyOf: [
          { type: "number", asCell: ["cell"] },
          { type: "number" },
        ],
      }))
    ).toThrow(/uses cell wrapper/);

    expect(() =>
      consumeStreamEventContract(contract({
        allOf: [
          { type: "number", asCell: ["stream"] },
          { type: "number", asCell: ["cell"] },
        ],
      }))
    ).toThrow(/uses cell wrapper/);

    const recursive = {} as { anyOf?: JSONSchema[] };
    recursive.anyOf = [recursive as JSONSchema];
    expect(() =>
      localizeStreamEventContract(
        contract(recursive as JSONSchema),
      )
    ).toThrow(/recursive stream event schema/);
  });
});

describe("piece pull materialization", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "pull-materialization-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves explicit Stream capability without guessing from opaque views", () => {
    expect(resolveDeclaredStreamCapability([undefined, true, true])).toBe(
      true,
    );
    expect(resolveDeclaredStreamCapability([undefined])).toBe(false);
    expect(() => resolveDeclaredStreamCapability([true, false])).toThrow(
      /disagree on Stream capability/,
    );
  });

  it("distinguishes absent projection documents from failed reads", () => {
    const resolved = runtime.getCell(
      manager.getSpace(),
      "projection-read-" + crypto.randomUUID(),
    ).getAsNormalizedFullLink();
    const transaction = (
      result: unknown,
    ): Parameters<typeof rawResolvedValueAtPath>[0] =>
      ({ read: () => result }) as unknown as Parameters<
        typeof rawResolvedValueAtPath
      >[0];

    expect(
      rawResolvedValueAtPath(
        transaction({ error: { name: "NotFoundError" } }),
        resolved,
      ),
    ).toEqual({ present: false, value: undefined });
    expect(() =>
      rawResolvedValueAtPath(
        transaction({ error: { name: "StorageFailure" } }),
        resolved,
      )
    ).toThrow(/projection alias document read failed: StorageFailure/);
    expect(
      rawResolvedValueAtPath(
        transaction({ ok: { value: { metadata: {} } } }),
        resolved,
      ),
    ).toEqual({ present: false, value: undefined });
    expect(
      rawResolvedValueAtPath(
        transaction({
          ok: { value: { value: { nested: { value: 7 } } } },
        }),
        { ...resolved, path: ["nested", "value"] },
      ),
    ).toEqual({ present: true, value: 7 });
  });

  it("follows materialized Cells and fails closed on recursive write authority", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const argument = manager.getArgument(piece);

    expect(
      materializedValueAtPath({ argument }, ["argument", "input"]),
    ).toBe(5);
    expect(materializedValueAtPath(1, ["missing"])).toBeUndefined();
    expect(() => assertWritablePiecePath(true, [], false, false, argument)).not
      .toThrow();

    const recursive = {} as { anyOf?: JSONSchema[] };
    recursive.anyOf = [recursive as JSONSchema];
    expect(() =>
      assertWritablePiecePath(
        recursive as JSONSchema,
        ["value"],
        false,
        true,
        argument,
      )
    ).toThrow(/recursive Cell schema/);
  });

  it("rejects conflicting and descendant Stream destinations", async () => {
    const rootCell = runtime.getCell(
      manager.getSpace(),
      "destination-contract-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      rootCell.withTx(tx).setRawUntyped({
        value: 1,
        channel: { nested: 1 },
      });
    });
    const destination = (
      root: JSONSchema,
      path: (string | number)[],
    ): Parameters<typeof localizeWritableDestinationContracts>[0] => ({
      root,
      path,
      rawBasePath: [],
      schemaBaseDepth: 0,
      validationCell: rootCell,
      validationPath: path,
    });

    const conflicting: JSONSchema = {
      type: "object",
      properties: {
        value: { type: "number", asCell: ["cell"] },
      },
      patternProperties: {
        "^value$": { type: "number", asCell: ["readonly"] },
      },
    };
    expect(() =>
      localizeWritableDestinationContracts(
        destination(conflicting, ["value"]),
        rootCell,
        2,
      )
    ).toThrow(/write destination Cell constraints disagree/);

    const stream: JSONSchema = {
      type: "object",
      properties: {
        channel: {
          type: "object",
          properties: { nested: { type: "number" } },
          asCell: ["stream"],
        },
      },
    };
    expect(() =>
      localizeWritableDestinationContracts(
        destination(stream, ["channel", "nested"]),
        rootCell,
        2,
      )
    ).toThrow(/stream Cell write destination path is not writable/);
  });

  it("requires a transaction before reconciling a raw projection alias", () => {
    const base = runtime.getCell(
      manager.getSpace(),
      "projection-base-" + crypto.randomUUID(),
    );
    const source = runtime.getCell(
      manager.getSpace(),
      "projection-source-" + crypto.randomUUID(),
    );
    const raw = source.getAsLink({ base, includeSchema: false });

    expect(() =>
      omitMissingProjectionAliases(
        undefined,
        raw,
        undefined,
        base,
        manager,
      )
    ).toThrow(/projection alias reconciliation requires a transaction/);
  });

  it("fails closed for ambiguous producer and destination Cell contracts", async () => {
    const ordinarySourceSchema: JSONSchema = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    };
    const makeSource = async (schema: JSONSchema) => {
      const source = await manager.runPersistent(
        trustPattern(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: ordinarySourceSchema,
          result: { value: 7 },
          nodes: [],
        }),
        {},
        undefined,
        { start: true },
      );
      await runtime.editWithRetry((tx) => {
        source.withTx(tx).setMetaRaw("schema", schema);
      });
      return source;
    };
    const base = runtime.getCell(
      manager.getSpace(),
      "link-contract-base-" + crypto.randomUUID(),
    );
    const supplied = (source: typeof base) => [{
      path: [],
      value: source.key("value"),
    }];

    const ordinary = await makeSource(ordinarySourceSchema);
    const recursiveTarget = {} as { anyOf?: JSONSchema[] };
    recursiveTarget.anyOf = [recursiveTarget as JSONSchema];
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(ordinary),
        recursiveTarget as JSONSchema,
        base,
        manager,
      )
    ).toThrow(/recursive Cell schema/);

    const incompatibleOuter: JSONSchema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "number", asCell: ["readonly"] },
            { type: "number", asCell: ["writeonly"] },
          ],
        },
      },
      required: ["value"],
    };
    const incompatible = await makeSource(incompatibleOuter);
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(incompatible),
        { type: "number" },
        base,
        manager,
      )
    ).toThrow(/incompatible outer capabilities/);
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(incompatible),
        { type: "number", asCell: ["cell"] },
        base,
        manager,
      )
    ).toThrow(/incompatible outer capabilities/);

    const conflictingOuter: JSONSchema = {
      type: "object",
      properties: {
        value: { type: "number", asCell: ["cell"] },
      },
      patternProperties: {
        "^value$": { type: "number", asCell: ["readonly"] },
      },
      required: ["value"],
    };
    const conflicting = await makeSource(conflictingOuter);
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(conflicting),
        { type: "number" },
        base,
        manager,
      )
    ).toThrow(/source Cell constraints disagree/);
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(conflicting),
        { type: "number", asCell: ["cell"] },
        base,
        manager,
      )
    ).toThrow(/source Cell constraints disagree/);
  });

  it("recovers only producer-owned argument and internal contracts", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const internalCell = piece.key("output").resolveAsCell();
    const originalInternal = piece.getMetaRaw("internal");
    expect(Array.isArray(originalInternal)).toBe(true);
    const unrelated = runtime.getCell(
      manager.getSpace(),
      "unrelated-internal-" + crypto.randomUUID(),
      { type: "number" },
    );
    const orphan = runtime.getCell(
      manager.getSpace(),
      "orphan-internal-" + crypto.randomUUID(),
      { type: "number" },
    );

    await runtime.editWithRetry((tx) => {
      piece.withTx(tx).setMetaRaw("internal", [
        null,
        {},
        { link: "malformed" },
        {
          link: unrelated.withTx(tx).getAsWriteRedirectLink({
            base: piece.withTx(tx),
            includeSchema: true,
          }),
        },
        ...(originalInternal as unknown[]),
      ]);
      orphan.withTx(tx).setMetaRaw(
        "result",
        piece.withTx(tx).getAsWriteRedirectLink({
          base: orphan.withTx(tx),
          includeSchema: true,
        }),
      );
    });

    expect(durableSourceContract(internalCell, manager)?.schemas.length)
      .toBeGreaterThan(0);
    expect(durableSourceContract(orphan, manager)).toBeUndefined();
  });

  it("terminates projection reconciliation cycles", async () => {
    const source = runtime.getCell(
      manager.getSpace(),
      "projection-cycle-source-" + crypto.randomUUID(),
    );
    const base = runtime.getCell(
      manager.getSpace(),
      "projection-cycle-base-" + crypto.randomUUID(),
    );

    await runtime.editWithRetry((tx) => {
      source.withTx(tx).setRawUntyped(7);
      const sourceWithTx = source.withTx(tx);
      const baseWithTx = base.withTx(tx);
      const normalized = sourceWithTx.getAsNormalizedFullLink();
      const resolving = new Set([JSON.stringify([
        normalized.space,
        normalized.id,
        normalized.scope,
        normalized.path,
      ])]);
      expect(
        omitMissingProjectionAliases(
          "already-materialized",
          sourceWithTx.getAsLink({
            base: baseWithTx,
            includeSchema: false,
          }),
          undefined,
          baseWithTx,
          manager,
          true,
          [],
          resolving,
        ),
      ).toBe("already-materialized");
    });
  });

  it("rejects writes redirected to cells without producer contracts", async () => {
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const orphan = runtime.getCell(
      manager.getSpace(),
      "redirect-without-contract-" + crypto.randomUUID(),
      { type: "number" },
    );
    const argument = manager.getArgument(target);
    await runtime.editWithRetry((tx) => {
      const argumentWithTx = argument.withTx(tx);
      orphan.withTx(tx).set(1);
      argumentWithTx.key("slot").setRawUntyped(
        orphan.withTx(tx).getAsWriteRedirectLink({
          base: argumentWithTx.key("slot"),
          includeSchema: true,
        }),
      );
    });

    await expect(
      new PieceController(manager, target).input.set(2, ["slot"]),
    ).rejects.toThrow(/write destination has no durable schema contract/);
    expect(orphan.get()).toBe(1);
  });

  it("exposes source provenance and Piece dependency relationships", async () => {
    const sourceProgram = compiledMultiplierProgram("source", 2);
    const source = await manager.runPersistent(
      await runtime.patternManager.compilePattern(sourceProgram, {
        space: manager.getSpace(),
      }),
      { input: 5 },
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 1 },
      undefined,
      { start: true },
    );
    const sourceController = new PieceController(manager, source);
    const targetController = new PieceController(manager, target);

    expect(await sourceController.getPatternSourceFiles()).toEqual(
      sourceProgram.files,
    );
    expect(await targetController.getPatternSourceFiles()).toBeUndefined();

    await manager.link(
      sourceController.id,
      ["output"],
      targetController.id,
      ["input"],
    );
    const originalGetPieces = manager.getPieces.bind(manager);
    manager.getPieces = () =>
      Promise.resolve({
        get: () => [source, target],
      } as unknown as Awaited<ReturnType<typeof manager.getPieces>>);
    try {
      expect((await targetController.readingFrom()).map((piece) => piece.id))
        .toEqual([sourceController.id]);
      expect((await sourceController.readBy()).map((piece) => piece.id))
        .toEqual([targetController.id]);
    } finally {
      manager.getPieces = originalGetPieces;
    }
  });

  it("keeps pattern content refs useful when source programs are unavailable", async () => {
    const identityless = runtime.getCell(
      manager.getSpace(),
      "identityless-piece-" + crypto.randomUUID(),
      { type: "object", properties: {} },
    );
    expect(await new PieceController(manager, identityless).getPatternRef())
      .toBeUndefined();

    const program = compiledMultiplierProgram("unavailable-source", 2);
    const piece = await manager.runPersistent(
      await runtime.patternManager.compilePattern(program, {
        space: manager.getSpace(),
      }),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const identityRef = getPatternIdentityRef(piece)!;
    const contentOnlyRef = {
      ...identityRef,
      source: { ref: `cf:pattern:${identityRef.identity}` },
    };
    const originalLookup = runtime.patternManager
      .getPatternSourceProgramByIdentity.bind(runtime.patternManager);

    try {
      runtime.patternManager.getPatternSourceProgramByIdentity = () =>
        Promise.resolve(undefined);
      expect(await controller.getPatternRef()).toEqual(contentOnlyRef);

      runtime.patternManager.getPatternSourceProgramByIdentity = () =>
        Promise.reject(new Error("source unavailable"));
      expect(await controller.getPatternRef()).toEqual(contentOnlyRef);
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity = originalLookup;
    }
  });

  it("distinguishes absent setup patterns from unknown stored identities", async () => {
    const emptyPiece = runtime.getCell(
      manager.getSpace(),
      "missing-setup-pattern-" + crypto.randomUUID(),
      { type: "object", properties: {} },
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await runtime.setup(undefined, undefined, {}, emptyPiece);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([
      "No pattern provided and no pattern found in result metadata. Not running.",
    ]);

    const unknownPiece = runtime.getCell(
      manager.getSpace(),
      "unknown-setup-pattern-" + crypto.randomUUID(),
      { type: "object", properties: {} },
    );
    await runtime.editWithRetry((tx) => {
      unknownPiece.withTx(tx).setMetaRaw("patternIdentity", {
        identity: "Z".repeat(43),
        symbol: "default",
      });
    });

    await expect(runtime.setup(undefined, undefined, {}, unknownPiece))
      .rejects.toThrow(`Unknown pattern: ${"Z".repeat(43)}#default`);
  });

  it("pulls before reading result values", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();

    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).key("input").set(7);
    });

    expect(await controller.result.get(["output"])).toBe(14);
  });

  it("materializes piece results before setInput returns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.setInput({ input: 7 });

    expect(manager.getResult(piece).get()).toEqual({ output: 14 });
  });

  it("rejects setInput values outside the current argument schema", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await expect(
      controller.setInput({ input: "wrong" } as unknown as { input: number }),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);
    expect((await controller.input.getCell()).getRaw()).toEqual({ input: 5 });
    expect(await controller.result.get()).toEqual({ output: 10 });

    await manager.stopPiece(piece);
    await expect(
      controller.setInput({ input: "still wrong" } as unknown as {
        input: number;
      }),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);
    expect((await controller.input.getCell()).getRaw()).toEqual({ input: 5 });
  });

  it("validates path-based input writes against the current schema", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set(7, ["input"]);
    expect(await controller.input.get()).toEqual({ input: 7 });
    expect(await controller.result.get()).toEqual({ output: 14 });

    await expect(controller.input.set("invalid", ["input"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    await expect(controller.input.set(new Date(), ["input"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    expect(await controller.input.get()).toEqual({ input: 7 });

    await controller.result.set(99, ["output"]);
    expect(await controller.result.get()).toEqual({ output: 99 });
  });

  it("ignores missing optional result aliases when validating a path write", async () => {
    const model = {
      type: "object",
      properties: {
        value: { type: "number" },
        arrayField: { type: "array", items: { type: "number" } },
      },
      required: ["value"],
    } as const;
    const pattern: Pattern = {
      argumentSchema: model,
      resultSchema: model,
      result: {
        value: { $alias: { cell: "argument", path: ["value"] } },
        arrayField: {
          $alias: { cell: "argument", path: ["arrayField"] },
        },
      },
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { value: 1 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    expect(await controller.result.get()).toEqual({ value: 1 });
    await controller.result.set(2, ["value"]);
    expect(await controller.result.get()).toEqual({ value: 2 });

    await expect(controller.result.set("bad", ["value"])).rejects.toThrow(
      /updated result does not match its schema/,
    );
    expect(await controller.result.get()).toEqual({ value: 2 });
  });

  it("does not hide invalid raw result siblings during path validation", async () => {
    const resultSchema = {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a"],
    } as const;
    const piece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema,
        result: { a: 1, b: 2 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      piece.withTx(tx).key("b").setRawUntyped("bad");
    });
    const controller = new PieceController(manager, piece);

    expect(piece.get()).toEqual({ a: 1 });
    expect(piece.getRaw()).toEqual({ a: 1, b: "bad" });
    await expect(controller.result.set(3, ["a"])).rejects.toThrow(
      /updated result does not match its schema/,
    );
    expect(piece.getRaw()).toEqual({ a: 1, b: "bad" });
  });

  it("does not hide present explicit undefined behind an optional alias", async () => {
    const model = {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a"],
    } as const;
    const piece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: model,
        resultSchema: model,
        result: {
          a: { $alias: { cell: "argument", path: ["a"] } },
          b: { $alias: { cell: "argument", path: ["b"] } },
        },
        nodes: [],
      }),
      { a: 1 },
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      manager.getArgument(piece).withTx(tx).key("b").setRawUntyped(undefined);
    });
    const argument = manager.getArgument(piece);
    const controller = new PieceController(manager, piece);

    expect(Object.hasOwn(argument.getRaw() as object, "b")).toBe(true);
    expect(Object.hasOwn(piece.get(), "b")).toBe(false);
    await expect(controller.result.set(3, ["a"])).rejects.toThrow(
      /updated result does not match its schema/,
    );
    expect(argument.getRaw()).toEqual({ a: 1, b: undefined });
  });

  it("reconciles missing projections through root and nested result aliases", async () => {
    const model = {
      type: "object",
      properties: {
        value: { type: "number" },
        arrayField: { type: "array", items: { type: "number" } },
      },
      required: ["value"],
    } as const;
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: model,
        resultSchema: model,
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
          arrayField: {
            $alias: { cell: "argument", path: ["arrayField"] },
          },
        },
        nodes: [],
      }),
      { value: 1 },
      undefined,
      { start: true },
    );
    const rootTarget = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: model,
        result: { value: 0 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const nestedSchema = {
      type: "object",
      properties: { nested: model },
      required: ["nested"],
    } as const;
    const nestedTarget = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: nestedSchema,
        result: { nested: { value: 0 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      rootTarget.withTx(tx).set(source);
      nestedTarget.withTx(tx).key("nested").set(source);
    });

    expect(rootTarget.get()).toEqual({ value: 1 });
    expect(nestedTarget.get()).toEqual({ nested: { value: 1 } });
    await expect(
      new PieceController(manager, rootTarget).result.set(3, ["value"]),
    ).resolves.toBeUndefined();
    await expect(
      new PieceController(manager, nestedTarget).result.set(4, [
        "nested",
        "value",
      ]),
    ).resolves.toBeUndefined();
    expect(source.get()).toEqual({ value: 4 });
  });

  it("reconciles a missing optional projection at a cold derived Cell root", async () => {
    const resultSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        optional: { type: "array", items: { type: "number" } },
      },
      required: ["value"],
    } as const;
    const piece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema,
        derivedInternalCells: [{
          partialCause: "optional",
          schema: { type: "array", items: { type: "number" } },
        }],
        result: {
          value: 1,
          optional: {
            $alias: { partialCause: "optional", path: [] },
          },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    expect(piece.get()).toEqual({ value: 1 });
    await expect(controller.result.set(2, ["value"]))
      .resolves.toBeUndefined();
    expect(piece.get()).toEqual({ value: 2 });
  });

  it("retains explicit undefined at an optional derived Cell root", async () => {
    const resultSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        optional: { type: "array", items: { type: "number" } },
      },
      required: ["value"],
    } as const;
    const piece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema,
        derivedInternalCells: [{
          partialCause: "optional",
          schema: { type: "array", items: { type: "number" } },
        }],
        result: {
          value: 1,
          optional: {
            $alias: { partialCause: "optional", path: [] },
          },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      piece.key("optional").withTx(tx).resolveAsCell()
        .setRawUntyped(undefined);
    });
    const controller = new PieceController(manager, piece);

    expect(piece.get()).toEqual({ value: 1 });
    await expect(controller.result.set(2, ["value"])).rejects.toThrow(
      /updated result does not match its schema/,
    );
    expect(piece.getRaw()).toMatchObject({ value: 1 });
  });

  it("validates result stream payloads independently of sibling projections", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          event: { type: "number", asCell: ["stream"] },
        },
        required: ["event"],
      },
      resultSchema: {
        type: "object",
        properties: {
          event: { type: "number", asCell: ["stream"] },
          projection: {
            anyOf: [{
              type: "object",
              properties: {
                type: { type: "string", enum: ["projected"] },
                optionalObject: { type: "object" },
              },
              required: ["type"],
            }],
          },
        },
        required: ["event", "projection"],
      },
      result: {
        event: { $alias: { cell: "argument", path: ["event"] } },
        // This mirrors projections such as $FS: an optional nested alias can
        // materialize as present undefined even though the event is unrelated.
        projection: {
          type: "projected",
          optionalObject: {
            $alias: { cell: "argument", path: ["missing"] },
          },
        },
      },
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { event: { $stream: true } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const stream = manager.getArgument(piece).key("event");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.result.set(7, ["event"]);
      await runtime.idle();
      expect(events).toEqual([7]);

      await expect(controller.result.set("bad", ["event"])).rejects.toThrow(
        /updated result does not match its schema/,
      );
      expect(events).toEqual([7]);
    } finally {
      removeHandler();
    }
  });

  it("fails closed for mixed stream and non-stream result alternatives", async () => {
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: {
            event: { type: "number", asCell: ["stream"] },
          },
          required: ["event"],
        },
        resultSchema: {
          type: "object",
          properties: {
            event: {
              [keyword]: [
                { type: "number", asCell: ["stream"] },
                { type: "string" },
              ],
            },
          },
          required: ["event"],
        },
        result: {
          event: { $alias: { cell: "argument", path: ["event"] } },
        },
        nodes: [],
      };
      const piece = await manager.runPersistent(
        trustPattern(runtime, pattern),
        { event: { $stream: true } },
        undefined,
        { start: true },
      );
      const controller = new PieceController(manager, piece);
      const stream = manager.getArgument(piece).key("event");
      const events: unknown[] = [];
      const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
        events.push(event);
      }, stream.getAsNormalizedFullLink());

      try {
        const issue = new RegExp(
          `mixed stream and non-stream ${keyword} alternatives`,
        );
        await expect(controller.result.set(7, ["event"])).rejects.toThrow(
          issue,
        );
        await expect(
          controller.result.set("wrong", ["event"]),
        ).rejects.toThrow(issue);
        expect(events).toEqual([]);
      } finally {
        removeHandler();
      }
    }
  });

  it("retains unwrapped allOf constraints on stream payloads", async () => {
    const rootSchema: Pattern["argumentSchema"] = {
      type: "object",
      properties: { event: { $ref: "#/$defs/Event" } },
      required: ["event"],
      $defs: {
        Event: {
          allOf: [
            { $ref: "#/$defs/NumberStream" },
            { minimum: 0 },
          ],
        },
        NumberStream: { type: "number", asCell: ["stream"] },
      },
    };
    const pattern: Pattern = {
      argumentSchema: rootSchema,
      resultSchema: rootSchema,
      result: {
        event: { $alias: { cell: "argument", path: ["event"] } },
      },
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { event: { $stream: true } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const stream = manager.getArgument(piece).key("event");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.result.set(5, ["event"]);
      await runtime.idle();
      expect(events).toEqual([5]);
      await expect(controller.result.set(-1, ["event"])).rejects.toThrow(
        /updated result does not match its schema/,
      );
      expect(events).toEqual([5]);
    } finally {
      removeHandler();
    }
  });

  it("accepts nested Cell handles in result stream events", async () => {
    const eventSchema: Pattern["argumentSchema"] = {
      type: "object",
      properties: {
        handle: { type: "number", asCell: ["cell"] },
      },
      required: ["handle"],
      asCell: ["stream"],
    };
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { event: eventSchema },
        required: ["event"],
      },
      resultSchema: {
        type: "object",
        properties: { event: eventSchema },
        required: ["event"],
      },
      result: {
        event: { $alias: { cell: "argument", path: ["event"] } },
      },
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { event: { $stream: true } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const stream = manager.getArgument(piece).key("event");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    const numberSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 9 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const stringSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        result: { value: "wrong" },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const streamSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            event: { type: "number", asCell: ["stream"] },
          },
          required: ["event"],
        },
        resultSchema: {
          type: "object",
          properties: {
            event: { type: "number", asCell: ["stream"] },
          },
          required: ["event"],
        },
        result: {
          event: { $alias: { cell: "argument", path: ["event"] } },
        },
        nodes: [],
      }),
      { event: { $stream: true } },
      undefined,
      { start: true },
    );

    try {
      await controller.result.set(
        { handle: numberSource.key("value") },
        ["event"],
      );
      await runtime.idle();
      expect(events).toHaveLength(1);

      await expect(
        controller.result.set(
          { handle: stringSource.key("value") },
          ["event"],
        ),
      ).rejects.toThrow(
        /input link at event.handle.*type string is not accepted/s,
      );
      await expect(
        controller.result.set(
          { handle: streamSource.key("event") },
          ["event"],
        ),
      ).rejects.toThrow(/Stream handle is not accepted as cell/);
      expect(events).toHaveLength(1);
    } finally {
      removeHandler();
    }
  });

  it("validates stale result views against the durable result schema", async () => {
    const initialPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("string | number"),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 4 },
      "stale-result-write-" + crypto.randomUUID(),
      { start: true },
    );
    const staleController = new PieceController(manager, piece);
    const updater = new PieceController(manager, piece);

    await updater.setPattern(compiledResultNarrowingProgram("number"));
    await expect(
      staleController.result.set("bad", ["value"]),
    ).rejects.toThrow(/updated result does not match its schema/);
    expect(await updater.result.get(["value"])).toBe(4);
  });

  it("validates a union stream payload before sending exactly one event", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          slot: { $ref: "#/$defs/Event" },
        },
        required: ["slot"],
        $defs: {
          Event: {
            anyOf: [
              { $ref: "#/$defs/NumberEvent" },
              { $ref: "#/$defs/UndefinedEvent" },
            ],
          },
          NumberEvent: { type: "number", asCell: ["stream"] },
          UndefinedEvent: { type: "undefined", asCell: ["stream"] },
        },
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { slot: { $stream: true } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    const stream = inputCell.key("slot");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.input.set(5, ["slot"]);
      await runtime.idle();
      expect(events).toEqual([5]);

      await expect(controller.input.set("bad", ["slot"])).rejects.toThrow(
        /does not match/,
      );
      expect(events).toEqual([5]);

      const sourcePiece = await manager.runPersistent(
        trustPattern(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
          result: { value: 9 },
          nodes: [],
        }),
        {},
        undefined,
        { start: true },
      );
      const source = sourcePiece.key("value");
      const rawLink = source.getAsLink({
        base: inputCell.key("slot"),
        includeSchema: true,
      });
      await controller.input.set(rawLink, ["slot"]);
      await runtime.idle();
      expect(events).toHaveLength(2);

      const broadSource = await manager.runPersistent(
        trustPattern(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: {
            type: "object",
            properties: { value: { type: ["number", "string"] } },
            required: ["value"],
          },
          result: { value: 9 },
          nodes: [],
        }),
        {},
        undefined,
        { start: true },
      );
      await expect(
        controller.input.set(
          broadSource.key("value").getAsLink({
            base: inputCell.key("slot"),
            includeSchema: true,
          }),
          ["slot"],
        ),
      ).rejects.toThrow(/input link.*schema is not compatible/);

      await controller.input.set(undefined, ["slot"]);
      await runtime.idle();
      expect(events).toHaveLength(3);
      expect(Object.hasOwn(events, 2)).toBe(true);
      expect(events[2]).toBeUndefined();
      const rawAfterUndefined = inputCell.asSchema(undefined).get() as {
        slot?: unknown;
      };
      expect(
        Object.hasOwn(rawAfterUndefined, "slot") &&
          rawAfterUndefined.slot === undefined,
      ).toBe(false);
    } finally {
      removeHandler();
    }
  });

  it("accepts an opaque Cell supplied as a path value", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const source = sourcePiece.key("value");
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          handle: { type: "number", asCell: ["cell"] },
        },
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set(source, ["handle"]);

    expect(await controller.input.get(["handle"])).toBe(7);

    const incompatiblePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: ["string", "undefined"] },
          },
        },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      controller.input.set(incompatiblePiece.key("value"), ["handle"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const nestedPiece = await manager.runPersistent(
      trustPattern(runtime, {
        ...pattern,
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["cell", "cell"] },
          },
        },
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(manager, nestedPiece).input.set(source, ["handle"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const readonlyPiece = await manager.runPersistent(
      trustPattern(runtime, {
        ...pattern,
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["readonly"] },
          },
        },
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(manager, readonlyPiece).input.set(source, ["handle"]),
    ).resolves.toBeUndefined();
  });

  it("accepts a cold opaque Cell supplied as a path value", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["cell"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, targetPiece);

    await expect(
      controller.input.set(sourcePiece.key("value"), ["handle"]),
    ).resolves.toBeUndefined();
    expect(await controller.input.get(["handle"])).toBeUndefined();
    expect(
      Object.hasOwn(
        manager.getArgument(targetPiece).getRaw() as object,
        "handle",
      ),
    ).toBe(true);
  });

  it("accepts a cold opaque Cell in a whole setInput value", async () => {
    const payloadSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    } as const;
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: payloadSchema },
          required: ["value"],
        },
        // The producer contract is durable even while this target is cold.
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { ...payloadSchema, asCell: ["cell"] },
          },
          required: ["handle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { handle: sourcePiece.key("value") },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, targetPiece);

    await expect(
      controller.setInput({ handle: sourcePiece.key("value") }),
    ).resolves.toBeUndefined();
    expect(await controller.input.get(["handle"])).toBeUndefined();
  });

  it("accepts opaque Cell handles through uniform union wrappers", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: {
              anyOf: [
                { type: "number", asCell: ["cell"] },
                { type: "string", asCell: ["cell"] },
              ],
            },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(manager, targetPiece).input.set(
        sourcePiece.key("value"),
        ["handle"],
      ),
    ).resolves.toBeUndefined();
  });

  it("selects ordinary and optional Cell alternatives by the supplied value", async () => {
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            ordinaryOrHandle: {
              anyOf: [
                { type: "number" },
                { type: "number", asCell: ["cell"] },
              ],
            },
            optionalHandle: {
              anyOf: [
                { type: "number", asCell: ["cell"] },
                { type: "undefined" },
              ],
            },
          },
          required: ["ordinaryOrHandle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { ordinaryOrHandle: 0 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await expect(
      controller.input.set(1, ["ordinaryOrHandle"]),
    ).resolves.toBeUndefined();
    await expect(
      controller.input.set(source.key("value"), ["optionalHandle"]),
    ).resolves.toBeUndefined();
  });

  it("selects an ordinary union branch for descendant writes", async () => {
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const piece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: {
              anyOf: [payload, { ...payload, asCell: ["readonly"] }],
            },
          },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await expect(controller.input.set(2, ["slot", "n"]))
      .resolves.toBeUndefined();
    expect(manager.getArgument(piece).getRaw()).toEqual({ slot: { n: 2 } });
  });

  it("selects an ordinary union branch through a result redirect", async () => {
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const schema = {
      type: "object",
      properties: {
        slot: {
          anyOf: [payload, { ...payload, asCell: ["readonly"] }],
        },
      },
      required: ["slot"],
    } as const;
    const piece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: schema,
        resultSchema: schema,
        result: {
          slot: { $alias: { cell: "argument", path: ["slot"] } },
        },
        nodes: [],
      }),
      { slot: { n: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await expect(controller.result.set(2, ["slot", "n"]))
      .resolves.toBeUndefined();
    expect(manager.getArgument(piece).getRaw()).toEqual({ slot: { n: 2 } });
  });

  it("narrows Cell capabilities without granting new authority", async () => {
    const numberCell = (kind: "readonly" | "writeonly" | "comparable") => ({
      type: "number" as const,
      asCell: [kind],
    });
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            readonly: numberCell("readonly"),
            writeonly: numberCell("writeonly"),
            comparable: numberCell("comparable"),
          },
          required: ["readonly", "writeonly", "comparable"],
        },
        result: { readonly: 1, writeonly: 2, comparable: 3 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            comparable: numberCell("comparable"),
            opaqueFromWriteonly: { type: "number", asCell: ["opaque"] },
            opaqueFromComparable: { type: "number", asCell: ["opaque"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await expect(
      controller.input.set(source.key("readonly"), ["comparable"]),
    ).resolves.toBeUndefined();
    await expect(
      controller.input.set(source.key("writeonly"), ["opaqueFromWriteonly"]),
    ).rejects.toThrow(/capability cannot be exposed/);
    await expect(
      controller.input.set(source.key("comparable"), [
        "opaqueFromComparable",
      ]),
    ).rejects.toThrow(/capability cannot be exposed/);
  });

  it("does not strip restricted producer capabilities into ordinary aliases", async () => {
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            readonly: { ...payload, asCell: ["readonly"] },
            writeonly: { type: "number", asCell: ["writeonly"] },
          },
        },
        result: { readonly: { n: 1 }, writeonly: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            readableWritable: payload,
            readableNumber: { type: "number" },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await expect(
      controller.input.set(
        source.key("readonly").asSchema(payload),
        ["readableWritable"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);
    await expect(
      controller.input.set(
        source.key("writeonly").asSchema({ type: "number" }),
        ["readableNumber"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const preexisting = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: payload },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: source.key("readonly").asSchema(payload) },
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(manager, preexisting).input.set(2, ["slot", "n"]),
    ).rejects.toThrow(/write destination.*not writable/);
    expect(source.getRaw()).toEqual({
      readonly: { n: 1 },
      writeonly: 7,
    });
  });

  it("rejects writable links that widen producer payload contracts", async () => {
    const sourcePayload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    } as const;
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: sourcePayload },
          required: ["value"],
        },
        result: { value: { n: 1 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const widePayload = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
      additionalProperties: false,
    } as const;
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { ...widePayload, asCell: ["cell"] },
            value: widePayload,
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await expect(
      controller.input.set(source.key("value"), ["handle"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);
    await controller.input.set(source.key("value"), ["value"]);
    await expect(
      controller.input.set("bad", ["value", "n"]),
    ).rejects.toThrow(/updated input does not match its write destination/);
    expect(source.getRaw()).toEqual({ value: { n: 1 } });
  });

  it("rejects stream links that widen producer event contracts", async () => {
    const numberStream = { type: "number", asCell: ["stream"] } as const;
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { event: numberStream },
          required: ["event"],
        },
        resultSchema: {
          type: "object",
          properties: { event: numberStream },
          required: ["event"],
        },
        result: { event: { $alias: { cell: "argument", path: ["event"] } } },
        nodes: [],
      }),
      { event: { $stream: true } },
      undefined,
      { start: true },
    );
    const wideStream = {
      type: ["number", "string"],
      asCell: ["stream"],
    } as const;
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { event: wideStream },
          required: ["event"],
        },
        resultSchema: {
          type: "object",
          properties: { event: wideStream },
          required: ["event"],
        },
        result: {
          event: { $alias: { cell: "argument", path: ["event"] } },
        },
        nodes: [],
      }),
      { event: { $stream: true } },
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(manager, target).setInput({
        event: source.key("event"),
      }),
    ).rejects.toThrow(/input link.*schema is not compatible/);
  });

  it("rejects descendant writes through Stream wrappers", async () => {
    const event = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      asCell: ["stream"],
    } as const;
    const piece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { event },
          required: ["event"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { event: { $stream: true } },
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(manager, piece).input.set(2, ["event", "n"]),
    ).rejects.toThrow(/stream Cell path is not writable/);
  });

  it("does not amplify readonly handles or write through them", async () => {
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    } as const;
    const readonlyPayload = { ...payload, asCell: ["readonly"] } as const;
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: readonlyPayload },
          required: ["value"],
        },
        result: { value: { n: 1 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            readonlyHandle: readonlyPayload,
            writableHandle: { ...payload, asCell: ["cell"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await controller.input.set(source.key("value"), ["readonlyHandle"]);
    await expect(
      controller.input.set(2, ["readonlyHandle", "n"]),
    ).rejects.toThrow(/not writable/);
    await expect(
      controller.input.set(source.key("value"), ["writableHandle"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);
    expect(source.getRaw()).toEqual({ value: { n: 1 } });
  });

  it("validates writes against a narrowed redirect destination", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
        required: ["settings"],
      },
      resultSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: { n: { type: ["number", "string"] } },
            required: ["n"],
          },
        },
        required: ["settings"],
      },
      result: {
        settings: { $alias: { cell: "argument", path: ["settings"] } },
      },
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { settings: { n: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await expect(
      controller.result.set("bad", ["settings", "n"]),
    ).rejects.toThrow(/updated result does not match its write destination/);
    expect((await controller.input.getCell()).getRaw()).toEqual({
      settings: { n: 1 },
    });
  });

  it("re-proves supplied links against a narrowed redirect destination", async () => {
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        result: { value: "linked" },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              properties: { n: { type: "number" } },
              required: ["n"],
            },
          },
          required: ["settings"],
        },
        resultSchema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              properties: { n: { type: ["number", "string"] } },
              required: ["n"],
            },
          },
          required: ["settings"],
        },
        result: {
          settings: { $alias: { cell: "argument", path: ["settings"] } },
        },
        nodes: [],
      }),
      { settings: { n: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await expect(
      controller.result.set(source.key("value"), ["settings", "n"]),
    ).rejects.toThrow(/write destination/);
    expect((await controller.input.getCell()).getRaw()).toEqual({
      settings: { n: 1 },
    });
  });

  it("ignores a widened carried schema on a write destination", async () => {
    const narrow = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const wide = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
    } as const;
    const source = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: narrow },
          required: ["value"],
        },
        result: { value: { n: 1 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: wide },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await controller.input.set(source.key("value").asSchema(wide), ["slot"]);
    await expect(
      controller.input.set("bad", ["slot", "n"]),
    ).rejects.toThrow(/write destination/);
    expect(source.getRaw()).toEqual({ value: { n: 1 } });
  });

  it("ignores a widened carried schema on another Piece argument", async () => {
    const narrow = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const wide = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
    } as const;
    const producer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { value: narrow },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { value: narrow },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { value: { n: 1 } },
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: wide },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {
        slot: manager.getArgument(producer).key("value").asSchema(wide),
      },
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(manager, target).input.set("bad", ["slot", "n"]),
    ).rejects.toThrow(/write destination/);
    expect(manager.getArgument(producer).getRaw()).toEqual({
      value: { n: 1 },
    });
  });

  it("validates linked descendant writes against producer containers", async () => {
    const constrainedArray = {
      type: "array",
      items: { type: "number" },
      maxItems: 1,
    } as const;
    const producer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { arr: constrainedArray },
          required: ["arr"],
        },
        resultSchema: {
          type: "object",
          properties: { arr: constrainedArray },
          required: ["arr"],
        },
        result: {
          arr: { $alias: { cell: "argument", path: ["arr"] } },
        },
        nodes: [],
      }),
      { arr: [1] },
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: { type: "array", items: { type: "number" } },
          },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: [] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await controller.input.set(producer.key("arr"), ["slot"]);
    await expect(controller.input.set(2, ["slot", 1])).rejects.toThrow(
      /write destination/,
    );
    expect(manager.getArgument(producer).getRaw()).toEqual({ arr: [1] });
  });

  it("validates concrete writes through correlated producer projections", async () => {
    const producer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          description: "correlated numeric choice",
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { const: "n" },
                value: { type: "number" },
              },
              required: ["kind", "value"],
            },
            {
              type: "object",
              properties: {
                kind: { const: "s" },
                value: { type: "string" },
              },
              required: ["kind", "value"],
            },
          ],
        },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: ["number", "string"] },
          },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { kind: "n", value: 1 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, producer);

    await controller.result.set(2, ["value"]);
    expect(manager.getArgument(producer).getRaw()).toEqual({
      kind: "n",
      value: 2,
    });

    await expect(controller.result.set("bad", ["value"]))
      .rejects.toThrow(/write destination/);
    expect(manager.getArgument(producer).getRaw()).toEqual({
      kind: "n",
      value: 2,
    });

    const futureValue = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 3 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      controller.result.set(futureValue.key("value"), ["value"]),
    ).rejects.toThrow(/write destination/);
    expect(manager.getArgument(producer).getRaw()).toEqual({
      kind: "n",
      value: 2,
    });
  });

  it("retains selected Cell authority through correlated projections", async () => {
    const choiceSchema = {
      anyOf: [{
        type: "object",
        properties: {
          kind: { const: "readonly" },
          value: { type: "number", asCell: ["readonly"] },
        },
        required: ["kind", "value"],
      }, {
        type: "object",
        properties: {
          kind: { const: "plain" },
          value: { type: "number" },
        },
        required: ["kind", "value"],
      }],
    } as const;
    const createProducer = (kind: "readonly" | "plain") =>
      manager.runPersistent(
        trustPattern(runtime, {
          argumentSchema: {
            type: "object",
            properties: { choice: choiceSchema },
            required: ["choice"],
          },
          resultSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
          result: {
            value: {
              $alias: {
                cell: "argument",
                path: ["choice", "value"],
              },
            },
          },
          nodes: [],
        }),
        { choice: { kind, value: 1 } },
        undefined,
        { start: true },
      );

    const readonlyProducer = await createProducer("readonly");
    const readonlyController = new PieceController(manager, readonlyProducer);
    await expect(readonlyController.result.set(2, ["value"]))
      .rejects.toThrow(/readonly Cell write destination is not writable/);
    expect(manager.getArgument(readonlyProducer).getRaw()).toEqual({
      choice: { kind: "readonly", value: 1 },
    });

    const plainProducer = await createProducer("plain");
    const plainController = new PieceController(manager, plainProducer);
    await plainController.result.set(2, ["value"]);
    expect(manager.getArgument(plainProducer).getRaw()).toEqual({
      choice: { kind: "plain", value: 2 },
    });

    const createProjectedProducer = (kind: "readonly" | "plain") =>
      manager.runPersistent(
        trustPattern(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: {
            anyOf: [{
              type: "object",
              properties: {
                kind: { const: "readonly" },
                value: { type: "number", asCell: ["readonly"] },
              },
              required: ["kind", "value"],
            }, {
              type: "object",
              properties: {
                kind: { const: "plain" },
                value: { type: "number" },
              },
              required: ["kind", "value"],
            }],
          },
          derivedInternalCells: [{
            partialCause: "value",
            schema: { type: "number" },
          }],
          result: {
            kind,
            value: { $alias: { partialCause: "value", path: [] } },
          },
          nodes: [],
        }),
        {},
        undefined,
        { start: true },
      );

    const projectedReadonly = await createProjectedProducer("readonly");
    await expect(
      new PieceController(manager, projectedReadonly).result.set(2, ["value"]),
    ).rejects.toThrow(/readonly Cell write destination is not writable/);
    expect(projectedReadonly.key("value").resolveAsCell().getRaw()).toBe(
      undefined,
    );

    const projectedPlain = await createProjectedProducer("plain");
    await new PieceController(manager, projectedPlain).result.set(2, ["value"]);
    expect(projectedPlain.key("value").resolveAsCell().getRaw()).toBe(2);
  });

  it("validates concrete writes through ambiguous container projections", async () => {
    const valueSchema = {
      type: ["object", "array"],
      properties: { x: { type: "number" } },
      required: ["x"],
      items: { type: "number" },
      uniqueItems: true,
      maximum: 10,
    } as const;
    const producer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { value: valueSchema },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { value: true },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { value: { x: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, producer);

    await controller.result.set(2, ["value", "x"]);
    expect(manager.getArgument(producer).getRaw()).toEqual({
      value: { x: 2 },
    });

    await controller.result.set([3], ["value"]);
    await controller.result.set(4, ["value", 0]);
    expect(manager.getArgument(producer).getRaw()).toEqual({ value: [4] });

    const futureValue = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 5 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      controller.result.set(futureValue.key("value"), ["value", 0]),
    ).rejects.toThrow(/correlated write destination/);
    expect(manager.getArgument(producer).getRaw()).toEqual({ value: [4] });

    const bareSchema = { type: ["object", "array"] } as const;
    const bareProducer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { value: bareSchema },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { value: true },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { value: { x: 1 } },
      undefined,
      { start: true },
    );
    const bareController = new PieceController(manager, bareProducer);
    await bareController.result.set(2, ["value", "x"]);
    expect(manager.getArgument(bareProducer).getRaw()).toEqual({
      value: { x: 2 },
    });
    await bareController.result.set([3], ["value"]);
    await bareController.result.set(4, ["value", 0]);
    expect(manager.getArgument(bareProducer).getRaw()).toEqual({ value: [4] });

    const arrayProducer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            value: {
              type: ["object", "array"],
              items: { type: "number" },
              dependentRequired: { x: ["y"] },
              propertyNames: { type: "string" },
            },
          },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { value: true },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { value: [1] },
      undefined,
      { start: true },
    );
    await new PieceController(manager, arrayProducer).result.set(
      2,
      ["value", 0],
    );
    expect(manager.getArgument(arrayProducer).getRaw()).toEqual({ value: [2] });
  });

  it("intersects argument and public result destination contracts", async () => {
    const narrow = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const wide = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
    } as const;
    const producer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { settings: wide },
          required: ["settings"],
        },
        resultSchema: {
          type: "object",
          properties: { settings: narrow },
          required: ["settings"],
        },
        result: {
          settings: { $alias: { cell: "argument", path: ["settings"] } },
        },
        nodes: [],
      }),
      { settings: { n: 1 } },
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: wide },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await controller.input.set(producer.key("settings"), ["slot"]);
    await expect(controller.input.set("bad", ["slot", "n"]))
      .rejects.toThrow(/write destination/);
    expect(manager.getArgument(producer).getRaw()).toEqual({
      settings: { n: 1 },
    });
  });

  it("intersects internal and public result destination contracts", async () => {
    const narrow = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      default: { n: 1 },
    } as const;
    const wide = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
    } as const;
    const producer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: wide },
          required: ["value"],
        },
        derivedInternalCells: [{
          partialCause: "value",
          schema: narrow,
        }],
        result: {
          value: { $alias: { partialCause: "value", path: [] } },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: wide },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await controller.input.set(producer.key("value"), ["slot"]);
    await expect(controller.input.set("bad", ["slot", "n"]))
      .rejects.toThrow(/write destination/);
    expect(producer.get()).toEqual({ value: { n: 1 } });
  });

  it("materializes Cell ancestors when staging descendant result writes", async () => {
    const eventSchema = {
      type: "number",
      asCell: ["stream"],
    } as const;
    const payloadSchema = {
      type: "object",
      properties: {
        x: { type: "number" },
        sibling: eventSchema,
      },
      required: ["x", "sibling"],
      asCell: ["cell"],
    } as const;
    const producer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { payload: payloadSchema, event: eventSchema },
          required: ["payload", "event"],
        },
        derivedInternalCells: [{
          partialCause: "payload",
          schema: payloadSchema,
        }, {
          partialCause: "event",
          schema: eventSchema,
        }],
        result: {
          payload: { $alias: { partialCause: "payload", path: [] } },
          event: { $alias: { partialCause: "event", path: [] } },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, producer);
    const payload = producer.key("payload").resolveAsCell();

    await controller.result.set(
      { x: 1, sibling: producer.key("event") },
      ["payload"],
    );
    const sibling = (payload.getRaw() as { sibling: unknown }).sibling;
    await controller.result.set(2, ["payload", "x"]);

    expect(payload.getRaw()).toEqual({
      x: 2,
      sibling,
    });
  });

  it("ignores opaque nested aliases when identifying Stream capability", async () => {
    const mentionableSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    } as const;
    const eventSchema = {
      type: "object",
      properties: {
        piece: {
          $ref: "#/$defs/Mentionable",
          asCell: ["cell"],
        },
      },
      required: ["piece"],
      asCell: ["stream"],
    } as const;
    const streamSchema = {
      ...eventSchema,
      $defs: { Mentionable: mentionableSchema },
    } as const;
    const mentionable = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: mentionableSchema,
        result: { name: "target" },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const producer = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            event: eventSchema,
            sibling: {
              type: "object",
              properties: { detail: { type: "string" } },
              required: ["detail"],
              asCell: ["stream"],
            },
            opaque: true,
          },
          required: ["event", "sibling", "opaque"],
          $defs: { Mentionable: mentionableSchema },
        },
        derivedInternalCells: [{
          partialCause: "event",
          schema: streamSchema,
        }, {
          partialCause: "sibling",
          schema: {
            type: "object",
            properties: { detail: { type: "string" } },
            required: ["detail"],
            asCell: ["stream"],
          },
        }],
        result: {
          event: { $alias: { partialCause: "event", path: [] } },
          sibling: { $alias: { partialCause: "sibling", path: [] } },
          opaque: {
            handler: { $alias: { partialCause: "event", path: [] } },
          },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, producer);
    const stream = producer.key("event").resolveAsCell();
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.result.set({ piece: mentionable }, ["event"]);
      await runtime.idle();
      expect(events).toHaveLength(1);
    } finally {
      removeHandler();
    }
  });

  it("accepts a Piece Stream supplied to a Stream Cell input", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            events: { $ref: "#/$defs/Event" },
          },
          required: ["events"],
          $defs: {
            Event: { type: "number", asCell: ["stream"] },
          },
        },
        result: { events: { $stream: true } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            events: { $ref: "#/$defs/Event" },
          },
          $defs: {
            Event: { type: "number", asCell: ["stream"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    const controller = new PieceController(manager, targetPiece);
    await expect(
      controller.setInput({ events: sourcePiece.key("events") }),
    ).resolves.toBeUndefined();

    const inputCell = await controller.input.getCell();
    await expect(
      controller.setInput({
        events: sourcePiece.key("events").getAsLink({
          base: inputCell.key("events"),
          includeSchema: true,
        }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      controller.setInput({
        events: sourcePiece.key("events").getAsLink({
          base: inputCell.key("events"),
          includeSchema: false,
        }),
      }),
    ).rejects.toThrow(/does not preserve its durable stream wrapper/);
  });

  it("rejects conflicting and forged Cell wrapper contracts", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    const conflictingTarget = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["cell"] },
          },
          patternProperties: {
            "^handle$": { type: "number", asCell: ["readonly"] },
          },
          additionalProperties: false,
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(manager, conflictingTarget).input.set(
        sourcePiece.key("value"),
        ["handle"],
      ),
    ).rejects.toThrow(/destination Cell constraints disagree/);

    const scalarTarget = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
          additionalProperties: false,
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const scalarController = new PieceController(manager, scalarTarget);
    const scalarInput = await scalarController.input.getCell();
    const forged = sourcePiece.key("value").getAsLink({
      base: scalarInput.key("slot"),
      includeSchema: true,
    });
    (linkRefPayload(forged) as { schema?: JSONSchema }).schema = {
      type: "number",
      asCell: ["cell"],
    };
    await expect(
      scalarController.input.set(forged, ["slot"]),
    ).rejects.toThrow(/link carries a non-durable Cell wrapper/);
  });

  it("projects nested Cell wrappers with the canonical link schema", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            value: {
              type: "object",
              properties: {
                handle: {
                  $ref: "#/$defs/NumberValue",
                  asCell: ["cell"],
                },
              },
              required: ["handle"],
              additionalProperties: false,
            },
          },
          required: ["value"],
          $defs: { NumberValue: { type: "number" } },
        },
        result: { value: { handle: 7 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: {
              type: "object",
              properties: { handle: { $ref: "#/$defs/NumberValue" } },
              required: ["handle"],
              additionalProperties: false,
            },
          },
          required: ["slot"],
          $defs: { NumberValue: { type: "number" } },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { handle: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, targetPiece);

    await controller.input.set(sourcePiece.key("value"), ["slot"]);
    expect(await controller.input.get(["slot"])).toEqual({ handle: 7 });
  });

  it("checks patternProperties on both sides of a durable path link", async () => {
    const broadSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const patternedTarget = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          patternProperties: { "^x": { type: "number" } },
          additionalProperties: true,
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { xSlot: 0 },
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(manager, patternedTarget).input.set(
        broadSource.key("value"),
        ["xSlot"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const patternedSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          patternProperties: {
            "^x": { type: ["number", "string"] },
          },
          additionalProperties: false,
        },
        result: { xSlot: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const numericTarget = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(manager, numericTarget).input.set(
        patternedSource.key("xSlot"),
        ["slot"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);
  });

  it("includes possible source-path omission in durable link contracts", async () => {
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const target = new PieceController(manager, targetPiece);
    const optionalSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          additionalProperties: false,
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    // The current value is a number, but a future schema-valid source write can
    // omit the raw path and make the retained link yield Fabric `undefined`.
    await expect(
      target.input.set(optionalSource.key("value"), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const defaultedOptionalSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number", default: 5 } },
          additionalProperties: false,
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    // Defaults are annotations on a source contract, not structural proof that
    // a future raw producer value contains the linked path.
    await expect(
      target.input.set(defaultedOptionalSource.key("value"), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const optionalTargetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: { type: ["number", "undefined"] },
          },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const optionalTarget = new PieceController(manager, optionalTargetPiece);
    await optionalTarget.input.set(optionalSource.key("value"), ["slot"]);
    await new PieceController(manager, optionalSource).result.set({});
    expect(await optionalTarget.input.get(["slot"])).toBeUndefined();

    const requiredSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        result: { value: 2 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await target.input.set(requiredSource.key("value"), ["slot"]);
    expect(await target.input.get(["slot"])).toBe(2);
    await expect(
      new PieceController(manager, requiredSource).result.set({}),
    ).rejects.toThrow(/does not match/);

    const conditionallyObjectSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 3 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      target.input.set(conditionallyObjectSource.key("value"), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const maybeShortArray = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: { type: "array", items: { type: "number" } },
        result: [3],
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      target.input.set(maybeShortArray.key(0), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const nonemptyArray = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "array",
          items: { type: "number" },
          minItems: 1,
        },
        result: [4],
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      target.input.set(nonemptyArray.key(0), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    await optionalTarget.input.set(nonemptyArray.key(0), ["slot"]);
    const sparse = Array(1);
    expect(validateSchemaValue(
      {
        type: "array",
        items: { type: "number" },
        minItems: 1,
      },
      sparse,
    )).toBeUndefined();
    await new PieceController(manager, nonemptyArray).result.set(sparse);
    expect(await optionalTarget.input.get(["slot"])).toBeUndefined();
  });

  it("rejects path links through correlated parent schemas", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { const: "n" },
                value: { type: "number" },
              },
              required: ["kind", "value"],
            },
            {
              type: "object",
              properties: {
                kind: { const: "s" },
                value: { type: "string" },
              },
              required: ["kind", "value"],
            },
          ],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { kind: "n", value: 0 },
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(manager, targetPiece).input.set(
        sourcePiece.key("value"),
        ["value"],
      ),
    ).rejects.toThrow(/anyOf correlates the linked field/);
  });

  it("uses destination scope as a follow cap for every durable link", async () => {
    const sourcePattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
        required: ["value"],
      },
      result: { value: 1 },
      nodes: [],
    };
    const spaceSource = await manager.runPersistent(
      trustPattern(runtime, sourcePattern),
      {},
      undefined,
      { start: true },
    );
    const sessionPattern = trustPattern(runtime, {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: { type: "number" },
      result: 7,
      nodes: [],
    });
    const sessionSource = runtime.getCell<number>(
      manager.getSpace(),
      "session-source-" + crypto.randomUUID(),
      sessionPattern.resultSchema,
      undefined,
      "session",
    );
    await runtime.setup(undefined, sessionPattern, {}, sessionSource);
    await sessionSource.sync();
    expect(sessionSource.getAsNormalizedFullLink().scope).toBe("session");
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number", scope: "user" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, targetPiece);

    await controller.input.set(spaceSource.key("value"), ["slot"]);
    await expect(
      controller.input.set(sessionSource, ["slot"]),
    ).rejects.toThrow(/scope session exceeds the destination scope/);

    const handleTarget = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: {
              type: "number",
              asCell: [{ kind: "cell", scope: "user" }],
            },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(manager, handleTarget).input.set(
        sessionSource,
        ["handle"],
      ),
    ).rejects.toThrow(/scope session exceeds the destination scope/);
  });

  it("checks a durable link schema even when its current value is undefined", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          slot: { type: ["number", "undefined"] },
        },
        required: ["slot"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { slot: undefined },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    const compatibleSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: ["number", "undefined"] },
          },
          required: ["value"],
        },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const incompatibleSource = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: ["string", "undefined"] },
          },
          required: ["value"],
        },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const compatible = compatibleSource.key("value");
    const incompatible = incompatibleSource.key("value");

    await controller.input.set(
      compatible.getAsLink({
        base: inputCell.key("slot"),
        includeSchema: true,
      }),
      ["slot"],
    );
    await expect(
      controller.input.set(
        incompatible.getAsLink({
          base: inputCell.key("slot"),
          includeSchema: true,
        }),
        ["slot"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const compatibleController = new PieceController(manager, compatibleSource);
    await compatibleController.result.set(7, ["value"]);
    expect(await controller.input.get(["slot"])).toBe(7);
    await expect(
      compatibleController.result.set("bad", ["value"]),
    ).rejects.toThrow(/updated result does not match its schema/);
    expect(await controller.input.get(["slot"])).toBe(7);
  });

  it("ignores a narrowed carried schema in favor of the producer contract", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, targetPiece);
    const inputCell = await controller.input.getCell();
    const narrowed = sourcePiece.key("value").asSchema({ type: "number" });

    await expect(
      controller.input.set(
        narrowed.getAsLink({
          base: inputCell.key("slot"),
          includeSchema: true,
        }),
        ["slot"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);
    await expect(
      controller.input.set(narrowed, ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const standalone = runtime.getCell<number>(
      manager.getSpace(),
      "standalone-link-without-contract-" + crypto.randomUUID(),
      { type: "number" },
    );
    await runtime.editWithRetry((tx) => standalone.withTx(tx).set(1));
    await expect(
      controller.input.set(standalone, ["slot"]),
    ).rejects.toThrow(/source has no durable schema contract/);

    const argumentSourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { value: 1 },
      undefined,
      { start: true },
    );
    await expect(
      controller.input.set(
        manager.getArgument(argumentSourcePiece).key("value"),
        ["slot"],
      ),
    ).resolves.toBeUndefined();
    expect(await controller.input.get(["slot"])).toBe(1);
  });

  it("hydrates path defaults while retaining raw explicit undefined", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: {
              mode: { type: "string" },
              attempts: { type: "number", default: 1 },
              label: {
                type: ["string", "undefined"],
                default: "fallback",
              },
            },
            required: ["mode", "attempts", "label"],
          },
        },
        required: ["settings"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { settings: { mode: "old", attempts: 1, label: "old" } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set(
      { mode: "new", label: undefined },
      ["settings"],
    );
    const settings = await controller.input.get(["settings"]) as Record<
      string,
      unknown
    >;
    expect(settings.mode).toBe("new");
    expect(settings.attempts).toBe(1);
    expect(Object.hasOwn(settings, "label")).toBe(true);
    // Typed reads intentionally project a schema default over undefined.
    expect(settings.label).toBe("fallback");
    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get() as { settings: Record<string, unknown> };
    expect(Object.hasOwn(rawInput.settings, "label")).toBe(true);
    expect(rawInput.settings.label).toBeUndefined();

    await controller.input.set("again", ["settings", "label"]);
    await controller.input.set(undefined, ["settings", "label"]);
    const explicit = await controller.input.get(["settings"]) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(explicit, "label")).toBe(true);
    expect(explicit.label).toBe("fallback");
    const rawExplicit = (await controller.input.getCell()).asSchema(undefined)
      .get() as { settings: Record<string, unknown> };
    expect(Object.hasOwn(rawExplicit.settings, "label")).toBe(true);
    expect(rawExplicit.settings.label).toBeUndefined();
  });

  it("stores explicit undefined at absent object and array paths", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          slot: { type: ["number", "undefined"] },
          label: {
            type: ["string", "undefined"],
            default: "fallback",
          },
          items: {
            type: "array",
            items: { type: ["number", "undefined"] },
          },
        },
        required: ["slot", "items"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const items = new Array(1);
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { items },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set(undefined, ["slot"]);
    await controller.input.set(undefined, ["label"]);
    await controller.input.set(undefined, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get() as { slot?: unknown; label?: unknown; items: unknown[] };
    expect(Object.hasOwn(rawInput, "slot")).toBe(true);
    expect(rawInput.slot).toBeUndefined();
    expect(Object.hasOwn(rawInput, "label")).toBe(true);
    expect(rawInput.label).toBeUndefined();
    expect(Object.hasOwn(rawInput.items, 0)).toBe(true);
    expect(rawInput.items[0]).toBeUndefined();
    expect(await controller.input.get(["label"])).toBe("fallback");
  });

  it("stores explicit undefined at result object and array paths", async () => {
    const resultSchema = {
      type: "object",
      properties: {
        slot: { type: ["number", "undefined"] },
        label: {
          type: ["string", "undefined"],
          default: "fallback",
        },
        items: {
          type: "array",
          items: { type: ["number", "undefined"] },
        },
      },
      required: ["items"],
    } as const;
    const resultItems = new Array(1);
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema,
      result: { items: resultItems },
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.result.set(undefined, ["slot"]);
    await controller.result.set(undefined, ["label"]);
    await controller.result.set(undefined, ["items", 0]);

    const rawResult = (await controller.result.getCell()).asSchema(undefined)
      .get() as { slot?: unknown; label?: unknown; items: unknown[] };
    expect(Object.hasOwn(rawResult, "slot")).toBe(true);
    expect(rawResult.slot).toBeUndefined();
    expect(Object.hasOwn(rawResult, "label")).toBe(true);
    expect(rawResult.label).toBeUndefined();
    expect(Object.hasOwn(rawResult.items, 0)).toBe(true);
    expect(rawResult.items[0]).toBeUndefined();
    expect(await controller.result.get(["label"])).toBe("fallback");
  });

  it("selects root union defaults for a path write", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "a" },
              settings: {
                type: "object",
                properties: {
                  attempts: { type: "number", default: 1 },
                },
                required: ["attempts"],
              },
            },
            required: ["kind", "settings"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "b" },
              settings: {
                type: "object",
                properties: {
                  retries: { type: "number", default: 2 },
                },
                required: ["retries"],
              },
            },
            required: ["kind", "settings"],
          },
        ],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { kind: "a", settings: { attempts: 7 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set({}, ["settings"]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({
      kind: "a",
      settings: { attempts: 1 },
    });
    expect(validateSchemaValue(pattern.argumentSchema, rawInput))
      .toBeUndefined();
    expect(await controller.input.get(["kind"])).toBe("a");

    await expect(controller.input.set("b", ["kind"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    const afterRejectedSwitch = (await controller.input.getCell()).asSchema(
      undefined,
    ).get();
    expect(afterRejectedSwitch).toEqual(rawInput);
    expect(validateSchemaValue(pattern.argumentSchema, afterRejectedSwitch))
      .toBeUndefined();
  });

  it("hydrates item-schema defaults for an array element write", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                mode: { type: "string" },
                attempts: { type: "number", default: 1 },
              },
              required: ["mode", "attempts"],
            },
          },
        },
        required: ["items"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { items: [{ mode: "old", attempts: 2 }] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set({ mode: "new" }, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({
      items: [{ mode: "new", attempts: 1 }],
    });
  });

  it("hydrates array item defaults for root and whole-array writes", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                attempts: { type: "number", default: 1 },
              },
              required: ["attempts"],
            },
          },
        },
        required: ["items"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { items: [{ attempts: 9 }] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set({ items: [{}] });
    expect(await controller.input.get()).toEqual({
      items: [{ attempts: 1 }],
    });

    await controller.input.set([{}], ["items"]);
    expect(await controller.input.get()).toEqual({
      items: [{ attempts: 1 }],
    });
  });

  it("uses a root discriminator to select array item defaults", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "a" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    attempts: { type: "number", default: 1 },
                  },
                  required: ["attempts"],
                },
              },
            },
            required: ["kind", "items"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "b" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    retries: { type: "number", default: 2 },
                  },
                  required: ["retries"],
                },
              },
            },
            required: ["kind", "items"],
          },
        ],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { kind: "a", items: [{ attempts: 7 }] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set({}, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({ kind: "a", items: [{ attempts: 1 }] });
  });

  it("materializes piece results before runWithPattern returns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );

    expect(manager.getResult(piece).get()).toEqual({ output: 10 });

    await manager.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(manager.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("stores repository metadata when preparing without starting", async () => {
    const repository = "https://github.com/commontoolsinc/labs";
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: false },
    );

    await manager.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: false, repository },
    );

    expect(getPatternRepository(piece)).toBe(repository);
  });

  it("persists setPattern replacement by identity for fresh runtime reloads", async () => {
    const repository = "https://github.com/commontoolsinc/labs";
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("v1", 2),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { input: 5 },
      "compiled-set-pattern-" + crypto.randomUUID(),
      { start: true, repository },
    );
    const id = entityRefToString(piece.entityId);
    const controller = new PieceController(manager, piece);
    const firstRef = getPatternIdentityRef(piece);

    expect(firstRef).toBeDefined();
    expect(manager.getResult(piece).get()).toEqual({
      version: "v1",
      output: 10,
    });

    await controller.setPattern(
      compiledMultiplierProgram(
        "v2",
        10,
        "/packages/patterns/examples/multiplier.tsx",
      ),
      { repository },
    );
    await manager.runtime.idle();
    await manager.synced();

    const secondRef = getPatternIdentityRef(piece);
    expect(secondRef).toBeDefined();
    expect(secondRef!.identity).not.toEqual(firstRef!.identity);
    expect(manager.getResult(piece).get()).toEqual({
      version: "v2",
      output: 50,
    });

    const session = await createSession({
      identity: signer,
      spaceName: manager.getSpaceName()!,
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const freshManager = new PieceManager(session, freshRuntime);
    const freshPieces = new PiecesController(freshManager);

    try {
      await freshManager.synced();
      const freshPiece = await freshPieces.get(id, true);
      const freshCell = freshPiece.getCell();
      const freshRef = getPatternIdentityRef(freshCell);

      expect(freshRef).toEqual(secondRef);
      expect(await freshPiece.result.get()).toEqual({
        version: "v2",
        output: 50,
      });
      const source = await freshPiece.getPatternSourceProgram();
      expect(source?.files.some((file) => file.contents.includes("v2"))).toBe(
        true,
      );
      expect(await freshPiece.getPatternRef()).toEqual({
        ...freshRef,
        source: {
          ref: `cf:pattern:${freshRef!.identity}`,
          repository,
          entry: "/packages/patterns/examples/multiplier.tsx",
        },
      });
      expect(getPatternRepository(freshCell)).toBe(repository);
    } finally {
      await freshRuntime.dispose();
    }
  });

  it("preserves a repository until a source update explicitly replaces it", async () => {
    const originalRepository = "https://github.com/commontoolsinc/labs";
    const replacementRepository = "https://github.com/commontoolsinc/patterns";
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("v1", 2),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { input: 5 },
      "repository-update-" + crypto.randomUUID(),
      { start: true, repository: originalRepository },
    );
    const controller = new PieceController(manager, piece);

    await controller.setPattern(compiledMultiplierProgram("v2", 3));
    expect(getPatternRepository(piece)).toBe(originalRepository);

    await controller.setPattern(compiledMultiplierProgram("v3", 4), {
      repository: replacementRepository,
    });
    expect(getPatternRepository(piece)).toBe(replacementRepository);
    expect((await controller.getPatternRef())?.source.repository).toBe(
      replacementRepository,
    );
  });

  it("updates a piece across backward-compatible schema additions", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "compatible-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    expect(await controller.input.get()).toEqual({ value: 4 });
    expect(await controller.result.get()).toEqual({ doubled: 4 });

    await controller.setPattern(compiledSchemaEvolutionProgram(2));

    const updatedPattern = await controller.getPattern();
    expect(updatedPattern.result).toMatchObject({ summary: "updated" });
    const inputProperties = updatedPattern.argumentSchema &&
        typeof updatedPattern.argumentSchema === "object"
      ? updatedPattern.argumentSchema.properties
      : undefined;
    expect(inputProperties?.mode).toMatchObject({
      type: ["number", "string"],
    });
    expect(await controller.input.get()).toEqual({
      value: 4,
      retries: 0,
      options: { attempts: 1 },
    });
    const rawInput = (await controller.input.getCell()).getRaw();
    expect(rawInput).toEqual({
      value: 4,
      retries: 0,
      options: { attempts: 1 },
    });
    expect(validateAgainstSchema(updatedPattern.argumentSchema, rawInput))
      .toBeUndefined();
    expect(await controller.result.get()).toEqual({
      doubled: 4,
      summary: "updated",
    });
  });

  it("migrates defaults through array items and dynamic fields", async () => {
    const arrayPiece = await manager.runPersistent(
      await runtime.patternManager.compilePattern(
        compiledArrayItemDefaultsProgram(1),
        { space: manager.getSpace() },
      ),
      { items: [{}] },
      "array-default-migration-" + crypto.randomUUID(),
      { start: true },
    );
    const arrayController = new PieceController(manager, arrayPiece);
    await arrayController.setPattern(compiledArrayItemDefaultsProgram(2));
    expect((await arrayController.input.getCell()).getRaw()).toEqual({
      items: [{ attempts: 1 }],
    });

    const dynamicPiece = await manager.runPersistent(
      await runtime.patternManager.compilePattern(
        compiledDynamicDefaultsProgram(1),
        { space: manager.getSpace() },
      ),
      { extra: {} },
      "dynamic-default-migration-" + crypto.randomUUID(),
      { start: true },
    );
    const dynamicController = new PieceController(manager, dynamicPiece);
    await dynamicController.setPattern(compiledDynamicDefaultsProgram(2));
    expect((await dynamicController.input.getCell()).getRaw()).toEqual({
      extra: { attempts: 1 },
    });
  });

  it("updates a piece whose durable arguments contain links", async () => {
    const sourcePattern = doublePattern();
    sourcePattern.resultSchema = {
      type: "object",
      properties: { output: { type: "number" } },
      required: ["output"],
    };
    const source = await manager.runPersistent(
      trustPattern(runtime, sourcePattern),
      { input: 5 },
      "linked-update-source-" + crypto.randomUUID(),
      { start: true },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("v1", 2),
      { space: manager.getSpace() },
    );
    const target = await manager.runPersistent(
      firstPattern,
      { input: 1 },
      "linked-update-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await manager.link(
      entityRefToString(source.entityId),
      ["output"],
      entityRefToString(target.entityId),
      ["input"],
    );

    expect(await controller.input.get()).toEqual({ input: 10 });
    expect(await controller.result.get()).toEqual({
      version: "v1",
      output: 20,
    });
    const rawBefore = (await controller.input.getCell()).getRaw();
    expect(rawBefore).not.toEqual({ input: 10 });

    await controller.setPattern(compiledMultiplierProgram("v2", 10));

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toEqual({ input: 10 });
    expect(await controller.result.get()).toEqual({
      version: "v2",
      output: 100,
    });
  });

  it("preserves linked objects while adding nested defaults", async () => {
    const source = await manager.runPersistent(
      trustPattern(runtime, linkedSettingsSourcePattern()),
      {},
      "linked-object-default-source-" + crypto.randomUUID(),
      { start: true },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(1),
      { space: manager.getSpace() },
    );
    const target = await manager.runPersistent(
      firstPattern,
      { settings: { mode: "local" } },
      "linked-object-default-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await manager.link(
      entityRefToString(source.entityId),
      ["settings"],
      entityRefToString(target.entityId),
      ["settings"],
    );
    const rawBefore = (await controller.input.getCell()).getRaw();
    expect(await controller.input.get()).toMatchObject({
      settings: { mode: "linked" },
    });

    await controller.setPattern(compiledLinkedSettingsProgram(2));

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toEqual({
      settings: { mode: "linked", attempts: 1 },
    });
    expect(await controller.result.get()).toEqual({ mode: "linked" });
  });

  it("preserves caller-supplied raw links at and below a write path", async () => {
    const sourcePattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: {
              mode: { type: "string" },
              attempts: { type: "number" },
            },
            required: ["mode", "attempts"],
          },
        },
        required: ["settings"],
      },
      result: { settings: { mode: "linked", attempts: 3 } },
      nodes: [],
    };
    const source = await manager.runPersistent(
      trustPattern(runtime, sourcePattern),
      {},
      "raw-link-path-source-" + crypto.randomUUID(),
      { start: true },
    );
    const targetPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(2),
      { space: manager.getSpace() },
    );
    const target = await manager.runPersistent(
      targetPattern,
      { settings: { mode: "local", attempts: 1 } },
      "raw-link-path-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, target);
    await manager.link(
      entityRefToString(source.entityId),
      ["settings"],
      entityRefToString(target.entityId),
      ["settings"],
    );
    const rawBefore = (await controller.input.getCell()).getRaw() as {
      settings: unknown;
    };

    await controller.input.set(rawBefore.settings, ["settings"]);

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    await controller.input.set({ settings: rawBefore.settings });
    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toEqual({
      settings: { mode: "linked", attempts: 3 },
    });
  });

  it("rejects an incompatible schema update before changing the piece", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "incompatible-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const previousRef = getPatternIdentityRef(controller.getCell());

    await expect(
      controller.setPattern(compiledSchemaEvolutionProgram(3)),
    ).rejects.toThrow(/not backward compatible/);

    expect(getPatternIdentityRef(controller.getCell())).toEqual(previousRef);
    expect(await controller.input.get()).toEqual({ value: 4 });
    expect(await controller.result.get()).toEqual({ doubled: 4 });
  });

  it("does not hydrate an invalid partial default into an optional object", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalPartialDefaultProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-partial-default-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.setPattern(compiledOptionalPartialDefaultProgram(2));

    const updatedPattern = await controller.getPattern();
    const rawInput = (await controller.input.getCell()).getRaw();
    expect(rawInput).toEqual({ value: 4 });
    expect(validateSchemaValue(updatedPattern.argumentSchema, rawInput))
      .toBeUndefined();
  });

  it("does not hydrate an invalid partial ref default on first start", async () => {
    const pattern = await runtime.patternManager.compilePattern(
      compiledOptionalPartialDefaultProgram(2),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      pattern,
      { value: 4 },
      "optional-partial-default-first-start-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const rawInput = (await controller.input.getCell()).getRaw();

    expect(rawInput).toEqual({ value: 4 });
    expect(validateSchemaValue(pattern.argumentSchema, rawInput))
      .toBeUndefined();
  });

  it("preserves conflicting defined values while merging object defaults", async () => {
    const originalRepository = "https://github.com/commontoolsinc/labs";
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledDefaultedOptionsProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "defined-object-default-conflict-" + crypto.randomUUID(),
      { start: true, repository: originalRepository },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).setRawUntyped({
        value: 4,
        options: "legacy",
      });
    });
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledDefaultedOptionsProgram(2), {
        repository: "https://github.com/commontoolsinc/other",
      }),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(getPatternRepository(piece)).toBe(originalRepository);
    expect(inputCell.getRaw()).toEqual({ value: 4, options: "legacy" });
  });

  it("rejects an optional field update that conflicts with durable raw args", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-field-conflict-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).setRawUntyped({
        value: 4,
        mode: "legacy-string",
      });
    });
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledOptionalNumberFieldProgram(2)),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    const candidate = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(2),
      { space: manager.getSpace() },
    );
    await expect(
      manager.runWithPattern(candidate, controller.id),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(inputCell.getRaw()).toEqual({ value: 4, mode: "legacy-string" });
  });

  it("validates legacy-open setInput calls against the updated schema", async () => {
    const piece = await manager.runPersistent(
      await runtime.patternManager.compilePattern(
        compiledOptionalNumberFieldProgram(1),
        { space: manager.getSpace() },
      ),
      { value: 4 },
      "optional-field-set-input-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    await controller.setPattern(compiledOptionalNumberFieldProgram(2));

    await expect(
      controller.setInput({ value: 4, mode: "legacy-string" }),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);
    expect((await controller.input.getCell()).getRaw()).toEqual({ value: 4 });
  });

  it("re-proves retained durable links against the candidate schema", async () => {
    const sourcePiece = await manager.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const piece = await manager.runPersistent(
      await runtime.patternManager.compilePattern(
        compiledOptionalNumberFieldProgram(1),
        { space: manager.getSpace() },
      ),
      { value: 4 },
      "optional-field-linked-contract-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const previousRef = getPatternIdentityRef(piece);

    await controller.input.set(sourcePiece.key("value"), ["mode"]);
    await expect(
      controller.setPattern(compiledOptionalNumberFieldProgram(2)),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
  });

  it("does not accept a linked stream as an optional scalar during migration", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-field-stream-conflict-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    const stream = runtime.getCell(
      manager.getSpace(),
      "optional-field-stream-" + crypto.randomUUID(),
      { type: "number", asCell: ["stream"] },
    );
    await runtime.editWithRetry((tx) => {
      stream.withTx(tx).setRawUntyped({ $stream: true });
      inputCell.withTx(tx).key("mode").setRawUntyped(
        stream.getAsLink({
          base: inputCell,
          includeSchema: true,
          keepAsCell: KeepAsCell.OnlyStream,
        }),
      );
    });
    const rawBefore = inputCell.getRaw();
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledOptionalNumberFieldProgram(2)),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(inputCell.getRaw()).toEqual(rawBefore);
  });

  it("reapplies setInput against a concurrently installed pattern", async () => {
    const initialProgram = compiledMultiplierProgram("initial", 2);
    const winnerProgram = compiledMultiplierProgram("winner", 10);
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "set-input-pattern-race-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const oldInputEntered = defer<void>();
    const releaseOldInput = defer<void>();
    const originalRunWithPattern = manager.runWithPattern;
    manager.runWithPattern = async (pattern, pieceId, inputs, options) => {
      if (
        pattern === initialPattern &&
        (inputs as { input?: number } | undefined)?.input === 7
      ) {
        oldInputEntered.resolve();
        await releaseOldInput.promise;
      }
      return await originalRunWithPattern.call(
        manager,
        pattern,
        pieceId,
        inputs,
        options,
      );
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const inputUpdate = controller.setInput({ input: 7 });
      await oldInputEntered.promise;
      await controller.setPattern(winnerProgram);
      releaseOldInput.resolve();
      await inputUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(await controller.input.get()).toEqual({ input: 7 });
      expect(await controller.result.get()).toEqual({
        version: "winner",
        output: 70,
      });
    } finally {
      releaseOldInput.resolve();
      manager.runWithPattern = originalRunWithPattern;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("re-resolves input schema and defaults after a commit retry", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "piece-prop-schema-race-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const commitEntered = defer<void>();
    const releaseCommit = defer<void>();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptNextCommit = true;
    runtime.editWithRetry =
      ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptNextCommit) {
            interceptNextCommit = false;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof runtime.editWithRetry;

    try {
      const inputUpdate = controller.input.set({ value: 9 });
      await commitEntered.promise;
      await controller.setPattern(compiledSchemaEvolutionProgram(2));
      releaseCommit.resolve();
      await inputUpdate;

      const currentPattern = await controller.getPattern();
      const rawInput = (await controller.input.getCell()).getRaw();
      expect(rawInput).toEqual({
        value: 9,
        retries: 0,
        options: { attempts: 1 },
      });
      expect(validateSchemaValue(currentPattern.argumentSchema, rawInput))
        .toBeUndefined();
      expect(await controller.result.get()).toEqual({
        doubled: 9,
        summary: "updated",
      });
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("re-resolves root schema defaults for a path write after retry", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { settings: { mode: "old" } },
      "piece-prop-path-schema-race-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const commitEntered = defer<void>();
    const releaseCommit = defer<void>();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptNextCommit = true;
    runtime.editWithRetry =
      ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptNextCommit) {
            interceptNextCommit = false;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof runtime.editWithRetry;

    try {
      const inputUpdate = controller.input.set(
        { mode: "new" },
        ["settings"],
      );
      await commitEntered.promise;
      await controller.setPattern(compiledLinkedSettingsProgram(2));
      releaseCommit.resolve();
      await inputUpdate;

      const currentPattern = await controller.getPattern();
      const rawInput = (await controller.input.getCell()).getRaw();
      expect(rawInput).toEqual({
        settings: { mode: "new", attempts: 1 },
      });
      expect(validateSchemaValue(currentPattern.argumentSchema, rawInput))
        .toBeUndefined();
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("rejects a source update whose validated pattern identity became stale", async () => {
    const initialProgram = compiledResultNarrowingProgram("string | number");
    const stringProgram = compiledResultNarrowingProgram("string");
    const numberProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const stringPattern = await runtime.patternManager.compilePattern(
      stringProgram,
      { space: manager.getSpace() },
    );
    const numberPattern = await runtime.patternManager.compilePattern(
      numberProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 4 },
      "concurrent-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const compileEntered = defer<void>();
    const releaseCompile = defer<void>();
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === stringProgram) {
        compileEntered.resolve();
        await releaseCompile.promise;
        return stringPattern;
      }
      if (program === numberProgram) return numberPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const staleUpdate = expect(controller.setPattern(stringProgram)).rejects
        .toThrow(/pattern changed while the source update was compiling/);
      await compileEntered.promise;
      await controller.setPattern(numberProgram);
      releaseCompile.resolve();
      await staleUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(numberPattern),
      );
      expect(await controller.result.get()).toEqual({ value: 4 });

      await expect(
        manager.runWithPattern(numberPattern, controller.id, undefined, {
          start: false,
          expectedPatternIdentity: getPatternIdentityRef(piece),
        }),
      ).rejects.toThrow(/atomic pattern updates require starting the piece/);
    } finally {
      releaseCompile.resolve();
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("rechecks the expected identity after a real commit-conflict retry", async () => {
    const initialProgram = compiledMultiplierProgram("initial", 1);
    const staleProgram = compiledMultiplierProgram("stale", 2);
    const winnerProgram = compiledMultiplierProgram("winner", 10);
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const stalePattern = await runtime.patternManager.compilePattern(
      staleProgram,
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "commit-conflict-update-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(manager, piece);
    const commitEntered = defer<void>();
    const releaseCommit = defer<void>();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptNextCommit = true;
    runtime.editWithRetry =
      ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptNextCommit) {
            interceptNextCommit = false;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof runtime.editWithRetry;
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === staleProgram) return stalePattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const staleUpdate = expect(controller.setPattern(staleProgram)).rejects
        .toThrow(/pattern changed while the source update was compiling/);
      await commitEntered.promise;
      await controller.setPattern(winnerProgram);
      releaseCommit.resolve();
      await staleUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(await controller.result.get()).toEqual({
        version: "winner",
        output: 50,
      });
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("returns the current winner's schema after a post-commit update race", async () => {
    const initialProgram = compiledResultNarrowingProgram(
      "string | number | boolean",
    );
    const firstProgram = compiledResultNarrowingProgram("string | number");
    const winnerProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      firstProgram,
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "post-commit-update-race-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(manager, piece);
    const firstPostCommitSync = defer<void>();
    const winnerPostCommitSync = defer<void>();
    const releaseFirst = defer<void>();
    const releaseWinner = defer<void>();
    const runnerInternals = runtime.runner as unknown as {
      syncCellsForRunningPattern(
        resultCell: unknown,
        pattern: Pattern,
        inputs?: unknown,
      ): Promise<boolean>;
    };
    const originalSync = runnerInternals.syncCellsForRunningPattern.bind(
      runtime.runner,
    );
    const syncCounts = new Map<Pattern, number>();
    runnerInternals.syncCellsForRunningPattern = async (
      resultCell,
      pattern,
      inputs,
    ) => {
      const synced = await originalSync(resultCell, pattern, inputs);
      const count = (syncCounts.get(pattern) ?? 0) + 1;
      syncCounts.set(pattern, count);
      if (count === 2 && pattern === firstPattern) {
        firstPostCommitSync.resolve();
        await releaseFirst.promise;
      } else if (count === 2 && pattern === winnerPattern) {
        winnerPostCommitSync.resolve();
        await releaseWinner.promise;
      }
      return synced;
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === firstProgram) return firstPattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const firstUpdate = controller.setPattern(firstProgram);
      await firstPostCommitSync.promise;
      const winnerUpdate = controller.setPattern(winnerProgram);
      await winnerPostCommitSync.promise;

      releaseWinner.resolve();
      await winnerUpdate;
      releaseFirst.resolve();
      await firstUpdate;
      await runtime.idle();

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(
        controller.getCell().getAsNormalizedFullLink().schema,
      ).toEqual(winnerPattern.resultSchema);
      expect(await controller.result.get()).toEqual({ value: 5 });
      expect(
        validateSchemaValue(
          controller.getCell().getAsNormalizedFullLink().schema!,
          { value: "invalid-for-winner" },
        ),
      ).toMatch(/value does not match type number/);
      expect(await controller.result.get()).toEqual({ value: 5 });
    } finally {
      releaseFirst.resolve();
      releaseWinner.resolve();
      runnerInternals.syncCellsForRunningPattern = originalSync;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("does not install an older controller mutation after a newer one", async () => {
    const initialProgram = compiledResultNarrowingProgram(
      "string | number | boolean",
    );
    const firstProgram = compiledResultNarrowingProgram("string | number");
    const winnerProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      firstProgram,
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "controller-update-race-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(manager, piece);
    const firstRunEntered = defer<void>();
    const releaseFirstRun = defer<void>();
    const originalRunWithPattern = manager.runWithPattern;
    manager.runWithPattern = async (
      pattern,
      pieceId,
      inputs,
      options,
    ) => {
      if (pattern === firstPattern) {
        firstRunEntered.resolve();
        await releaseFirstRun.promise;
        return piece.asSchema(firstPattern.resultSchema);
      }
      if (pattern === winnerPattern) {
        return piece.asSchema(winnerPattern.resultSchema);
      }
      return await originalRunWithPattern.call(
        manager,
        pattern,
        pieceId,
        inputs,
        options,
      );
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === firstProgram) return firstPattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const firstUpdate = controller.setPattern(firstProgram);
      await firstRunEntered.promise;
      await controller.setPattern(winnerProgram);
      releaseFirstRun.resolve();
      await firstUpdate;

      expect(controller.getCell().getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
    } finally {
      releaseFirstRun.resolve();
      manager.runWithPattern = originalRunWithPattern;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("keeps a committed newer schema after its post-commit failure", async () => {
    const initialProgram = compiledResultNarrowingProgram(
      "string | number | boolean",
    );
    const firstProgram = compiledResultNarrowingProgram("string | number");
    const winnerProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      firstProgram,
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "controller-post-commit-failure-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(manager, piece);
    const firstRunReturned = defer<void>();
    const releaseFirstRun = defer<void>();
    const originalRunWithPattern = manager.runWithPattern;
    manager.runWithPattern = async (
      pattern,
      pieceId,
      inputs,
      options,
    ) => {
      const cell = await originalRunWithPattern.call(
        manager,
        pattern,
        pieceId,
        inputs,
        options,
      );
      if (pattern === firstPattern) {
        firstRunReturned.resolve();
        await releaseFirstRun.promise;
      } else if (pattern === winnerPattern) {
        throw new Error("injected post-commit failure");
      }
      return cell;
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === firstProgram) return firstPattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const firstUpdate = controller.setPattern(firstProgram);
      await firstRunReturned.promise;
      await expect(controller.setPattern(winnerProgram)).rejects.toThrow(
        /injected post-commit failure/,
      );
      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );

      releaseFirstRun.resolve();
      await firstUpdate;

      expect(controller.getCell().getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
    } finally {
      releaseFirstRun.resolve();
      manager.runWithPattern = originalRunWithPattern;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("rechecks the durable identity after loading the winner's schema", async () => {
    const initialPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("string | number | boolean"),
      { space: manager.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("string"),
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("number"),
      { space: manager.getSpace() },
    );
    const firstRef = runtime.patternManager.getArtifactEntryRef(firstPattern);
    const winnerRef = runtime.patternManager.getArtifactEntryRef(winnerPattern);
    if (!firstRef || !winnerRef) {
      throw new Error("missing compiled pattern ref");
    }

    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "schema-load-race-" + crypto.randomUUID(),
      { start: false },
    );
    const loadEntered = defer<void>();
    const releaseLoad = defer<void>();
    const originalLoad = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    let heldFirstLoad = false;
    runtime.patternManager.loadPatternByIdentity = async (
      identity,
      symbol,
      space,
    ) => {
      const current = getPatternIdentityRef(piece);
      if (
        !heldFirstLoad && identity === firstRef.identity &&
        current?.identity === firstRef.identity &&
        current.symbol === firstRef.symbol
      ) {
        heldFirstLoad = true;
        loadEntered.resolve();
        await releaseLoad.promise;
      }
      return await originalLoad(identity, symbol, space);
    };

    try {
      const firstRun = runtime.runSynced(piece, firstPattern, { input: 5 });
      await loadEntered.promise;

      const winnerCell = await runtime.runSynced(
        piece,
        winnerPattern,
        { input: 5 },
      );
      expect(getPatternIdentityRef(piece)).toEqual(winnerRef);
      expect(winnerCell.getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );

      releaseLoad.resolve();
      const firstCell = await firstRun;
      expect(getPatternIdentityRef(piece)).toEqual(winnerRef);
      expect(firstCell.getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
    } finally {
      releaseLoad.resolve();
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
  });

  it("syncs dependencies after a remote pattern supersedes local setup", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("local", 2),
      { space: manager.getSpace() },
    );
    const remotePattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("remote", 10),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { input: 5 },
      "remote-preparation-supersession-" + crypto.randomUUID(),
      { start: false },
    );
    const id = entityRefToString(piece.entityId);
    const session = await createSession({
      identity: signer,
      spaceName: manager.getSpaceName()!,
    });
    const remoteRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const remoteManager = new PieceManager(session, remoteRuntime);

    try {
      await remoteManager.synced();
      await remoteManager.runWithPattern(
        remotePattern,
        id,
        { input: 5 },
        { start: false },
      );
      await remoteManager.synced();
      await manager.synced();
      await piece.pull();
      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(remotePattern),
      );

      const runnerInternals = runtime.runner as unknown as {
        syncCellsForRunningPattern(
          resultCell: unknown,
          pattern: Pattern,
          inputs?: unknown,
        ): Promise<boolean>;
      };
      const originalSync = runnerInternals.syncCellsForRunningPattern.bind(
        runtime.runner,
      );
      let dependencySyncs = 0;
      runnerInternals.syncCellsForRunningPattern = async (
        resultCell,
        pattern,
        inputs,
      ) => {
        if (pattern === remotePattern) dependencySyncs++;
        return await originalSync(resultCell, pattern, inputs);
      };
      try {
        await runtime.start(piece);
      } finally {
        runnerInternals.syncCellsForRunningPattern = originalSync;
      }

      expect(dependencySyncs).toBeGreaterThan(0);
      expect(await piece.pull()).toEqual({
        version: "remote",
        output: 50,
      });
    } finally {
      await remoteRuntime.dispose();
    }
  });

  it("waits for setup to settle before setupPersistent syncs pattern metadata", async () => {
    const pattern = doublePattern();
    const patternRef = { identity: "test-pattern-identity", symbol: "default" };
    const originalSetup = manager.runtime.setup.bind(manager.runtime);
    const originalGetArtifactEntryRef = manager.runtime.patternManager
      .getArtifactEntryRef.bind(manager.runtime.patternManager);
    const originalSyncPatternByIdentity = manager.syncPatternByIdentity.bind(
      manager,
    );
    let setupResolved = false;
    let releaseSetup: (() => void) | undefined;
    const setupCalled = defer<void>();

    manager.runtime.setup = ((...args) => {
      const piece = args[3];
      return new Promise<typeof piece>((resolve) => {
        releaseSetup = () => {
          setupResolved = true;
          resolve(piece);
        };
        setupCalled.resolve();
      });
    }) as typeof manager.runtime.setup;

    const getRefStub: unknown = () => patternRef;
    manager.runtime.patternManager.getArtifactEntryRef =
      getRefStub as typeof manager.runtime.patternManager.getArtifactEntryRef;

    manager.syncPatternByIdentity = ((
      ref: { identity: string; symbol: string },
    ) => {
      expect(ref).toEqual(patternRef);
      expect(setupResolved).toBe(true);
      return Promise.resolve(pattern);
    }) as typeof manager.syncPatternByIdentity;

    try {
      const pending = manager.setupPersistent(pattern, { input: 5 });
      await setupCalled.promise;
      expect(setupResolved).toBe(false);
      if (!releaseSetup) {
        throw new Error("Expected runtime.setup to be called");
      }
      releaseSetup();
      await pending;
    } finally {
      manager.runtime.setup = originalSetup;
      manager.runtime.patternManager.getArtifactEntryRef =
        originalGetArtifactEntryRef;
      manager.syncPatternByIdentity = originalSyncPatternByIdentity;
    }
  });

  it("restarts stopped pieces when runWithPattern is called with start", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);

    await manager.stopPiece(piece);

    expect(runtime.runner.cancels.size).toBe(0);

    await manager.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);
    expect(manager.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("updates piece names when runWithPattern changes patterns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, namedPattern("double", 2)),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    expect(controller.name()).toBe("double");
    expect(manager.getResult(piece).get()).toEqual({
      [NAME]: "double",
      output: 10,
    });

    await manager.runWithPattern(
      trustPattern(runtime, namedPattern("tenfold", 10)),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(controller.name()).toBe("tenfold");
    expect(manager.getResult(piece).get()).toEqual({
      [NAME]: "tenfold",
      output: 50,
    });
  });

  it("reads a piece addressed through a value-link wrapper (headless sub-piece slot)", async () => {
    // The canonical piece K — setup writes patternIdentity + the argument link.
    const k = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    expect(manager.getResult(k).get()).toEqual({ output: 10 });

    // A value-link "slot" cell R that redirects to K — the exact shape a piece
    // pushed into a list/object gets addressed by (the array/object element,
    // written as the child result cell's getAsLink()). Reproduces the topics
    // board's `addTopic`, whose array element is a plain value-link to the topic
    // piece; the slot itself carries no piece metadata.
    const r = runtime.getCell(
      manager.getSpace(),
      "wrapper-slot-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      r.withTx(tx).set(k.getAsLink());
    });
    await manager.synced();

    // Reading the argument directly off the slot fails exactly as
    // `cf piece inspect <slot-fid>` did before this fix:
    expect(() => manager.getArgument(r)).toThrow("piece missing argument cell");

    // Addressing the slot by its fid (the path `cf piece inspect`/`get` take)
    // canonicalizes R -> its result cell K (a VALUE link) in manager.get, so
    // input/result reads land on the real piece, not the un-materialized wrapper.
    const pieces = new PiecesController(manager);
    const piece = await pieces.get(entityRefToString(r.entityId), false);
    expect(await piece.result.get(["output"])).toBe(10);
    expect(await piece.input.get(["input"])).toBe(5);
  });
});

describe("piece cold-replica slot read (two replicas, one server)", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: SharedServerStorageManager;
  let writerRuntime: Runtime;
  let writerManager: PieceManager;
  let spaceName: string;

  beforeEach(async () => {
    server = newSharedServer();
    writerStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    writerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: writerStorage,
    });
    spaceName = "cold-slot-" + crypto.randomUUID();
    const session = await createSession({ identity: signer, spaceName });
    writerManager = new PieceManager(session, writerRuntime);
    await writerManager.synced();
  });

  afterEach(async () => {
    await writerRuntime?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  it("a fresh replica reads a piece addressed through a value-link slot (cold fetch)", async () => {
    // Writer replica: create the canonical piece K (setup writes patternIdentity
    // + the argument link), then a value-link slot R -> K — the exact shape the
    // topics board's addTopic produces — and sync both to the shared server.
    const k = await writerManager.runPersistent(
      trustPattern(writerRuntime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const r = writerRuntime.getCell(
      writerManager.getSpace(),
      "wrapper-slot-" + crypto.randomUUID(),
    );
    await writerRuntime.editWithRetry((tx) => {
      r.withTx(tx).set(k.getAsLink());
    });
    await writerManager.synced();
    const slotId = entityRefToString(r.entityId);

    // Fresh reader replica: a NEW storage manager on the SAME server, so it has
    // never pulled K. Reading the slot by its fid must canonicalize R -> K (a
    // VALUE link) AND cold-fetch K's docs from the server — the end-to-end
    // behavior the local-toolshed run confirmed, now repeatable in-process.
    const readerStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    const readerSession = await createSession({ identity: signer, spaceName });
    const readerManager = new PieceManager(readerSession, readerRuntime);
    try {
      await readerManager.synced();
      const readerPieces = new PiecesController(readerManager);
      const piece = await readerPieces.get(slotId, false);

      // Both reads canonicalize the slot R -> its result cell K (a value link)
      // and cold-fetch K from the shared server. The argument read is the path
      // that threw "piece missing argument cell" pre-fix, so exercise it first.
      expect(await piece.input.get(["input"])).toBe(5);
      expect(await piece.result.get(["output"])).toBe(10);
    } finally {
      await readerRuntime.dispose();
      await readerStorage.close();
    }
  });
});
