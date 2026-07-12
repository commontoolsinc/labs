import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createFactoryShell,
  factoryStateOf,
  isAdmittedFabricFactory,
  type LivePatternFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  findAllWriteRedirectCells,
  opaqueArgumentKeys,
  sendValueToBinding,
  unwrapOneLevelAndBindtoDoc,
} from "../src/pattern-binding.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  areLinksSame,
  areNormalizedLinksSame,
  getDerivedInternalCellLink,
  getMetaCell,
  isAliasBinding,
  parseLink,
} from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCell } from "../src/cell.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import {
  deriveFactoryStateCopy,
  noteDerivedCopy,
  setDurableArtifactEntryRef,
} from "../src/builder/pattern-metadata.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const ADDRESSABLE_PATTERN_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ value: number }>(({ value }) => ({ value }));",
      ].join("\n"),
    },
  ],
};

const FACTORY_REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
};

describe("params pseudo-alias runtime seam", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("writes through params pseudo-aliases only when the result owns a params cell", () => {
    const resultCell = runtime.getCell<{ publicValue: number }>(
      space,
      "params pseudo-alias write result",
      undefined,
      tx,
    );
    resultCell.set({ publicValue: 7 });
    const argumentCellLink = getMetaCell(resultCell, "argument", tx)
      .getAsNormalizedFullLink();
    const binding = {
      $alias: {
        cell: "params",
        path: ["capture"],
        schema: { type: "number" },
      },
    } as const;

    expect(() =>
      sendValueToBinding(
        tx,
        resultCell,
        argumentCellLink,
        binding,
        42,
      )
    ).toThrow("Invalid pseudo-alias path");

    // These casts keep the regression focused on the missing runtime seam.
    // WP3.4 widens the public metadata vocabulary in the green change.
    const paramsCell = getMetaCell(
      resultCell,
      "params" as Parameters<typeof getMetaCell>[1],
      tx,
      {
        type: "object",
        properties: { capture: { type: "number" } },
        required: ["capture"],
        additionalProperties: false,
      },
    );
    paramsCell.set({ capture: 1 });
    resultCell.setMetaRaw(
      "params" as Parameters<typeof resultCell.setMetaRaw>[0],
      paramsCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
      }),
    );

    sendValueToBinding(
      tx,
      resultCell,
      argumentCellLink,
      binding,
      42,
    );

    expect(paramsCell.key("capture").get()).toBe(42);
    expect(resultCell.getAsQueryResult()).toEqual({ publicValue: 7 });
  });

  it("resolves params pseudo-aliases only when the result owns a params cell", () => {
    const resultCell = runtime.getCell(
      space,
      "params pseudo-alias resolution result",
      undefined,
      tx,
    );
    const argumentCell = getMetaCell(resultCell, "argument", tx);
    const binding = {
      $alias: {
        cell: "params",
        path: ["capture"],
        schema: { type: "number" },
      },
    } as const;

    expect(() =>
      unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        binding,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
      )
    ).toThrow("Invalid pseudo-alias cell: params");

    // These casts keep the regression focused on the missing runtime seam.
    // WP3.4 widens the public metadata vocabulary in the green change.
    const paramsCell = getMetaCell(
      resultCell,
      "params" as Parameters<typeof getMetaCell>[1],
      tx,
      {
        type: "object",
        properties: { capture: { type: "number" } },
        required: ["capture"],
        additionalProperties: false,
      },
    );
    paramsCell.set({ capture: 7 });
    resultCell.setMetaRaw(
      "params" as Parameters<typeof resultCell.setMetaRaw>[0],
      paramsCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
      }),
    );

    const resolved = unwrapOneLevelAndBindtoDoc(
      runtime.cfc,
      binding,
      argumentCell.getAsNormalizedFullLink(),
      resultCell,
    );
    const resolvedLink = parseLink(resolved, resultCell)!;
    const paramsLink = paramsCell.getAsNormalizedFullLink();

    expect(resolvedLink.id).toBe(paramsLink.id);
    expect(resolvedLink.space).toBe(paramsLink.space);
    expect(resolvedLink.path).toEqual(["capture"]);
    expect(resolvedLink.overwrite).toBe("redirect");
  });
});

describe("pattern-binding", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("finds no opaque argument keys when a schema has no property map", () => {
    expect(opaqueArgumentKeys({ type: "array" })).toEqual(new Set());
  });

  describe("sendValueToBinding", () => {
    it("writes an admitted factory atomically through a redirect binding", () => {
      const testCell = runtime.getCell<{ factory?: unknown }>(
        space,
        "factory redirect binding",
        undefined,
        tx,
      );
      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();
      const factory = createFactoryShell({
        kind: "module",
        ref: FACTORY_REF,
        argumentSchema: true,
        resultSchema: true,
      });

      sendValueToBinding(
        tx,
        testCell,
        argumentCellLink,
        { $alias: { cell: "result", path: ["factory"] } },
        factory,
      );

      const stored = testCell.key("factory").getRaw();
      expect(isAdmittedFabricFactory(stored)).toBe(true);
      expect(factoryStateOf(stored)).toEqual(factoryStateOf(factory));
    });

    it("should send value to a simple binding", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "should send value to a simple binding 1",
        undefined,
        tx,
      );

      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();
      testCell.set({ value: 0 });
      sendValueToBinding(tx, testCell, argumentCellLink, {
        $alias: { cell: "result", path: ["value"] },
      }, 42);
      expect(testCell.getAsQueryResult()).toEqual({ value: 42 });
    });

    it("should handle array bindings", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "should handle array bindings 1",
        undefined,
        tx,
      );
      testCell.set({ arr: [0, 0, 0] });
      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();
      sendValueToBinding(
        tx,
        testCell,
        argumentCellLink,
        [{ $alias: { cell: "result", path: ["arr", "0"] } }, {
          $alias: { cell: "result", path: ["arr", "2"] },
        }],
        [1, 3],
      );
      expect(testCell.getAsQueryResult()).toEqual({ arr: [1, 0, 3] });
    });

    it("should handle bindings with multiple levels", () => {
      const testCell = runtime.getCell<{
        user: {
          name: {
            first: string;
            last: string;
          };
          age: number;
        };
      }>(
        space,
        "should handle bindings with multiple levels 1",
        undefined,
        tx,
      );
      testCell.set({
        user: {
          name: {
            first: "John",
            last: "Doe",
          },
          age: 30,
        },
      });
      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();

      const binding = {
        person: {
          fullName: {
            firstName: {
              $alias: { cell: "result", path: ["user", "name", "first"] },
            },
            lastName: {
              $alias: { cell: "result", path: ["user", "name", "last"] },
            },
          },
          currentAge: { $alias: { cell: "result", path: ["user", "age"] } },
        },
      };

      const value = {
        person: {
          fullName: {
            firstName: "Jane",
            lastName: "Smith",
          },
          currentAge: 25,
        },
      };

      sendValueToBinding(
        tx,
        testCell,
        argumentCellLink,
        binding,
        value,
      );

      expect(testCell.getAsQueryResult()).toEqual({
        user: {
          name: {
            first: "Jane",
            last: "Smith",
          },
          age: 25,
        },
      });
    });

    it("accepts a matching static primitive binding, including NaN", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "static primitive binding leaf 1",
        undefined,
        tx,
      );
      testCell.set({ value: 0 });
      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();

      // A static primitive binding matches an identical produced value...
      sendValueToBinding(tx, testCell, argumentCellLink, 42, 42);
      // ...including `NaN` (`Object.is` semantics; a `!==` check would
      // spuriously throw `Got NaN instead of NaN` here).
      sendValueToBinding(tx, testCell, argumentCellLink, NaN, NaN);
      // A genuine mismatch throws.
      expect(() => sendValueToBinding(tx, testCell, argumentCellLink, 42, 43))
        .toThrow("Got 43 instead of 42");
    });

    it("normalizes cell values before writing a narrower scoped binding", () => {
      const output = runtime.getCell<{ value: unknown }>(
        space,
        "narrow scoped binding cell value output",
        undefined,
        tx,
      );
      output.set({ value: null });
      const argumentCellLink = getMetaCell(output, "argument", tx)
        .getAsNormalizedFullLink();

      const source = runtime.getCell<string>(
        space,
        "narrow scoped binding cell value source",
        undefined,
        tx,
      );
      source.set("secret");

      sendValueToBinding(
        tx,
        output,
        argumentCellLink,
        output.key("value").getAsWriteRedirectLink(),
        source,
        { narrowestReadScope: "user" },
      );

      const scopedValue = runtime.getCellFromLink(
        { ...output.key("value").getAsNormalizedFullLink(), scope: "user" },
        undefined,
        tx,
      );
      const scopedRaw = scopedValue.getRaw();
      expect(isCell(scopedRaw)).toBe(false);
      expect(
        areNormalizedLinksSame(parseLink(scopedRaw as any, scopedValue)!, {
          ...source.getAsNormalizedFullLink(),
          path: [],
        }),
      ).toBe(true);

      const broadRaw = output.key("value").getRaw();
      expect(
        areNormalizedLinksSame(
          parseLink(broadRaw as any, output.key("value"))!,
          scopedValue.getAsNormalizedFullLink(),
        ),
      ).toBe(true);
    });

    it("normalizes nested cell values before writing a narrower scoped binding", () => {
      const output = runtime.getCell<{ value: unknown }>(
        space,
        "narrow scoped binding nested cell output",
        undefined,
        tx,
      );
      output.set({ value: null });
      const argumentCellLink = getMetaCell(output, "argument", tx)
        .getAsNormalizedFullLink();

      const source = runtime.getCell<string>(
        space,
        "narrow scoped binding nested cell source",
        undefined,
        tx,
      );
      source.set("secret");

      sendValueToBinding(
        tx,
        output,
        argumentCellLink,
        output.key("value").getAsWriteRedirectLink(),
        { nested: source },
        { narrowestReadScope: "user" },
      );

      const scopedValue = runtime.getCellFromLink(
        { ...output.key("value").getAsNormalizedFullLink(), scope: "user" },
        undefined,
        tx,
      );
      const scopedRaw = scopedValue.getRaw() as { nested?: unknown };
      expect(isCell(scopedRaw.nested)).toBe(false);
      expect(
        areNormalizedLinksSame(
          parseLink(scopedRaw.nested as any, scopedValue)!,
          {
            ...source.getAsNormalizedFullLink(),
            path: [],
          },
        ),
      ).toBe(true);
    });

    it("does not stamp scoped asCell alias schemas onto write redirect links", () => {
      const output = runtime.getCell<{ value: unknown }>(
        space,
        "scoped asCell alias write redirect output",
        undefined,
        tx,
      );
      output.set({ value: null });
      const argumentCellLink = getMetaCell(output, "argument", tx)
        .getAsNormalizedFullLink();

      const userScopedValue = runtime.getCellFromLink(
        { ...output.key("value").getAsNormalizedFullLink(), scope: "user" },
        undefined,
        tx,
      );

      sendValueToBinding(
        tx,
        output,
        argumentCellLink,
        {
          $alias: {
            cell: "result",
            path: ["value"],
            schema: {
              type: "string",
              asCell: [{ kind: "cell", scope: "user" }],
            },
          },
        },
        "secret",
      );

      expect(output.key("value").getRaw()).toBe("secret");
      expect(userScopedValue.getRaw()).toBeUndefined();
    });
  });

  describe("mapBindingToCell", () => {
    it("should map bindings to cell aliases", () => {
      // Bindings are pseudo-links; the initial "internal" or "argument" determines how they are resolved
      const binding = {
        x: { $alias: { partialCause: "a", path: [] } },
        y: { $alias: { cell: "argument", path: ["b", "c"] } },
        z: 3,
      };
      const resultCell = runtime.getCell<{ a: number }>(
        space,
        "result cell",
        undefined,
        tx,
      );
      const argumentCell = runtime.getCell<{ b: { c: number } }>(
        space,
        "argument cell",
        undefined,
        tx,
      );
      argumentCell.set({ b: { c: 2 } });
      const result = unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        binding,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
        { derivedInternalCells: [{ partialCause: "a" }] },
      );
      expect(
        areNormalizedLinksSame(
          parseLink(result.x, resultCell)!,
          getDerivedInternalCellLink(resultCell, {
            partialCause: "a",
          }),
        ),
      ).toBe(true);
      expect(
        areLinksSame(
          result.y,
          argumentCell.key("b").key("c").getAsWriteRedirectLink(),
        ),
      ).toBe(true);
    });

    it("uses the argument link schema when converting aliases", () => {
      const profileSchema = {
        type: "object",
        scope: "user",
        default: { name: "Ada" },
        ifc: { confidentiality: ["profile"] },
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      } as const;
      const argumentSchema = {
        type: "object",
        properties: {
          profile: profileSchema,
        },
        required: ["profile"],
      } as const;
      const binding = {
        profile: { $alias: { cell: "argument", path: ["profile"] } },
      };
      const resultCell = runtime.getCell(
        space,
        "schema fallback result cell",
        undefined,
        tx,
      );
      const argumentCell = runtime.getCell(
        space,
        "schema fallback argument cell",
        argumentSchema,
        tx,
      );
      const result = unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        binding,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
      ) as { profile: unknown };

      expect(parseLink(result.profile, resultCell)).toEqual({
        ...argumentCell.getAsNormalizedFullLink(),
        path: ["profile"],
        scope: "user",
        schema: profileSchema,
        overwrite: "redirect",
      });
    });

    it("serializes returned local pattern cells as aliases", () => {
      const frame = pushFrame({
        runtime,
        tx,
        space,
        cause: { test: "returned local pattern cells are aliases" },
      });
      try {
        const { pattern, Writable } = createTrustedBuilder(runtime)
          .commonfabric;
        const Root = pattern(() => {
          const name = Writable.of("Ada").for("name", true);
          return { name };
        });

        const nameBinding = (Root.result as { name: unknown }).name;
        expect(isAliasBinding(nameBinding)).toBe(true);
        expect(nameBinding).toEqual({
          $alias: {
            partialCause: "name",
            path: [],
            scope: "space",
            schema: { default: "Ada" },
          },
        });
      } finally {
        popFrame(frame);
      }
    });

    it("decrements deferred legacy aliases inside pattern values", () => {
      const resultCell = runtime.getCell(
        space,
        "deferred legacy aliases inside unbound pattern values",
        undefined,
        tx,
      );
      const argumentCell = getMetaCell(resultCell, "argument", tx);
      const nestedPattern = {
        argumentSchema: {},
        resultSchema: {},
        result: {
          $alias: { partialCause: "result", path: [], defer: 1 },
        },
        nodes: [
          {
            module: { type: "javascript", implementation: () => undefined },
            inputs: {
              value: {
                $alias: { cell: "argument", path: ["value"], defer: 1 },
              },
              later: {
                $alias: { partialCause: "later", path: [], defer: 2 },
              },
              nested: {
                argumentSchema: {},
                resultSchema: {},
                result: {
                  $alias: {
                    partialCause: "nested-result",
                    path: [],
                    defer: 2,
                  },
                },
                nodes: [],
              },
            },
            outputs: {
              $alias: { partialCause: "output", path: [], defer: 1 },
            },
          },
        ],
      };

      const result = unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        { op: nestedPattern },
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
      ) as { op: typeof nestedPattern };

      expect(result.op.result).toEqual({
        $alias: { partialCause: "result", path: [] },
      });
      expect(result.op.nodes[0].inputs.value).toEqual({
        $alias: { cell: "argument", path: ["value"] },
      });
      expect(result.op.nodes[0].inputs.later).toEqual({
        $alias: { partialCause: "later", path: [], defer: 1 },
      });
      expect(result.op.nodes[0].inputs.nested.result).toEqual({
        $alias: { partialCause: "nested-result", path: [], defer: 1 },
      });
      expect(result.op.nodes[0].outputs).toEqual({
        $alias: { partialCause: "output", path: [] },
      });
    });

    it("keeps a keyless callable pattern on the legacy live path", () => {
      const frame = pushFrame({
        runtime,
        tx,
        space,
        cause: { test: "keyless callable binding" },
      });
      try {
        const { pattern } = createTrustedBuilder(runtime).commonfabric;
        const keyless = pattern(() => ({ value: 1 }));
        expect(runtime.patternManager.getArtifactEntryRef(keyless))
          .toBeUndefined();

        const resultCell = runtime.getCell(
          space,
          "keyless callable binding",
          undefined,
          tx,
        );
        const argumentCell = getMetaCell(resultCell, "argument", tx);
        const bound = unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          keyless,
          argumentCell.getAsNormalizedFullLink(),
          resultCell,
        );
        expect(bound).toBe(keyless);
      } finally {
        popFrame(frame);
      }
    });

    it("keeps admitted addressable factories callable and binds compatibility graphs structurally", async () => {
      const compiled = await runtime.patternManager.compilePattern(
        ADDRESSABLE_PATTERN_PROGRAM,
      );
      const entryRef = runtime.patternManager.getArtifactEntryRef(compiled);
      expect(entryRef).toBeDefined();
      const derived = {
        argumentSchema: compiled.argumentSchema,
        resultSchema: compiled.resultSchema,
        result: compiled.result,
        nodes: compiled.nodes,
      };
      noteDerivedCopy(derived, compiled);

      const resultCell = runtime.getCell(
        space,
        "nested addressable patterns bind as refs",
        undefined,
        tx,
      );
      const argumentCell = getMetaCell(resultCell, "argument", tx);
      const bound = unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        {
          direct: compiled,
          nested: { operations: [compiled, derived] },
        },
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
      ) as {
        direct: unknown;
        nested: { operations: unknown[] };
      };

      expect(bound.direct).toBe(compiled);
      expect(bound.nested.operations[0]).toBe(compiled);
      expect(isAdmittedFabricFactory(bound.direct)).toBe(true);

      const graph = bound.nested.operations[1] as Record<string, unknown>;
      expect(Array.isArray(graph.nodes)).toBe(true);
      expect("$patternRef" in graph).toBe(false);

      setDurableArtifactEntryRef(compiled, entryRef!);
      const compiledState = factoryStateOf(compiled);
      if (compiledState.kind !== "pattern" || compiledState.ref === undefined) {
        throw new Error("expected addressable pattern factory state");
      }
      const decoded = createFactoryShell({
        kind: "pattern",
        ref: compiledState.ref,
        argumentSchema: compiledState.argumentSchema,
        resultSchema: compiledState.resultSchema,
      });
      expect(() =>
        sendValueToBinding(
          tx,
          resultCell,
          argumentCell.getAsNormalizedFullLink(),
          compiled,
          decoded,
        )
      ).not.toThrow();
    });

    it("binds aliases in hidden factory state while preserving callable identity semantics", () => {
      const frame = pushFrame({
        runtime,
        tx,
        space,
        cause: { test: "hidden factory binding aliases" },
      });
      try {
        const { pattern } = createTrustedBuilder(runtime).commonfabric;
        const base = pattern(() => ({ value: 1 }));
        const state = factoryStateOf(base);
        if (state.kind !== "pattern" || !("rootToken" in state)) {
          throw new Error("expected live pattern factory state");
        }
        const derive = (
          params: unknown,
          spaceSelector?: unknown,
        ) =>
          deriveFactoryStateCopy(
            base,
            {
              ...state,
              paramsSchema: true,
              params,
              ...(spaceSelector === undefined ? {} : { spaceSelector }),
            } satisfies LivePatternFactoryState,
          );

        const resultCell = runtime.getCell<Record<string, unknown>>(
          space,
          "hidden factory binding aliases",
          undefined,
          tx,
        );
        resultCell.set({ sink: 0 });
        const argumentCell = getMetaCell(resultCell, "argument", tx);
        const factory = derive(
          {
            fromArgument: {
              $alias: { cell: "argument", path: ["captured"] },
            },
          },
          { $alias: { cell: "result", path: ["targetSpace"] } },
        );

        const bound = unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          factory,
          argumentCell.getAsNormalizedFullLink(),
          resultCell,
        );
        const boundState = factoryStateOf(bound);
        if (boundState.kind !== "pattern") {
          throw new Error("expected bound pattern state");
        }

        expect(bound).not.toBe(factory);
        expect(isAdmittedFabricFactory(bound)).toBe(true);
        expect(
          parseLink(
            (boundState.params as { fromArgument: unknown }).fromArgument,
            resultCell,
          )?.path,
        ).toEqual(["captured"]);
        expect(parseLink(boundState.spaceSelector, resultCell)?.path).toEqual([
          "targetSpace",
        ]);

        const repeated = unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          { first: factory, second: factory },
          argumentCell.getAsNormalizedFullLink(),
          resultCell,
        ) as { first: unknown; second: unknown };
        expect(repeated.first).toBe(repeated.second);

        const links = findAllWriteRedirectCells(bound, resultCell);
        expect(links.map((link) => link.path)).toEqual([
          ["captured"],
          ["targetSpace"],
        ]);

        const outputBinding = derive({
          sink: { $alias: { cell: "result", path: ["sink"] } },
        });
        const outputValue = derive({ sink: 42 });
        sendValueToBinding(
          tx,
          resultCell,
          argumentCell.getAsNormalizedFullLink(),
          outputBinding,
          outputValue,
        );
        expect(resultCell.key("sink").get()).toBe(42);

        const unchanged = derive({ static: "same" });
        expect(unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          unchanged,
          argumentCell.getAsNormalizedFullLink(),
          resultCell,
        )).toBe(unchanged);
        expect(() =>
          sendValueToBinding(
            tx,
            resultCell,
            argumentCell.getAsNormalizedFullLink(),
            unchanged,
            unchanged,
          )
        ).not.toThrow();

        const invalid = derive({ fn: () => undefined });
        expect(() =>
          unwrapOneLevelAndBindtoDoc(
            runtime.cfc,
            invalid,
            argumentCell.getAsNormalizedFullLink(),
            resultCell,
          )
        ).toThrow("Arbitrary functions are not valid binding values");
      } finally {
        popFrame(frame);
      }
    });

    it("compares independent canonical shells by state and rejects arbitrary functions", () => {
      const state = () => ({
        kind: "pattern" as const,
        ref: FACTORY_REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: { bytes: new FabricBytes(new Uint8Array([1, 2, 3])) },
      });
      const left = createFactoryShell(state());
      const right = createFactoryShell(state());
      const different = createFactoryShell({
        ...state(),
        params: { bytes: new FabricBytes(new Uint8Array([9, 8, 7])) },
      });
      const resultCell = runtime.getCell(
        space,
        "canonical factory binding equality",
        undefined,
        tx,
      );
      const argumentCell = getMetaCell(resultCell, "argument", tx);

      expect(() =>
        sendValueToBinding(
          tx,
          resultCell,
          argumentCell.getAsNormalizedFullLink(),
          left,
          right,
        )
      ).not.toThrow();
      expect(() =>
        sendValueToBinding(
          tx,
          resultCell,
          argumentCell.getAsNormalizedFullLink(),
          left,
          different,
        )
      ).toThrow("Fabric special binding does not match value");
      expect(unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        left,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
      )).toBe(left);
      expect(findAllWriteRedirectCells(left, resultCell)).toEqual([]);

      const arbitrary = () => undefined;
      expect(() =>
        unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          arbitrary,
          argumentCell.getAsNormalizedFullLink(),
          resultCell,
        )
      ).toThrow("Arbitrary functions are not valid binding values");
      expect(() =>
        sendValueToBinding(
          tx,
          resultCell,
          argumentCell.getAsNormalizedFullLink(),
          arbitrary,
          arbitrary,
        )
      ).toThrow("Arbitrary functions are not valid binding values");
      expect(() => findAllWriteRedirectCells(arbitrary, resultCell)).toThrow(
        "Arbitrary functions are not valid binding values",
      );

      const forgedModuleShape = {
        type: "javascript",
        implementation: arbitrary,
      };
      expect(() =>
        unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          forgedModuleShape,
          argumentCell.getAsNormalizedFullLink(),
          resultCell,
        )
      ).toThrow("Arbitrary functions are not valid binding values");
      expect(() => findAllWriteRedirectCells(forgedModuleShape, resultCell))
        .toThrow("Arbitrary functions are not valid binding values");

      const legacyPatternWithAuthoredFunction = {
        argumentSchema: true,
        resultSchema: true,
        nodes: [],
        result: { authored: { toJSON: arbitrary } },
      };
      expect(() =>
        unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          legacyPatternWithAuthoredFunction,
          argumentCell.getAsNormalizedFullLink(),
          resultCell,
        )
      ).toThrow("Arbitrary functions are not valid binding values");
      expect(() =>
        findAllWriteRedirectCells(legacyPatternWithAuthoredFunction, resultCell)
      ).toThrow("Arbitrary functions are not valid binding values");
    });

    it("preserves only the named function fields of a structural legacy graph", () => {
      const patternToJSON = () => ({ legacy: "pattern" });
      const moduleToJSON = () => ({ legacy: "module" });
      const implementation = () => undefined;
      const legacyPattern = {
        argumentSchema: true,
        resultSchema: true,
        nodes: [{
          module: {
            type: "javascript",
            implementation,
            toJSON: moduleToJSON,
          },
          inputs: {},
          outputs: {},
        }],
        result: {},
        toJSON: patternToJSON,
      };
      const resultCell = runtime.getCell(
        space,
        "legacy graph function fields",
        undefined,
        tx,
      );
      const argumentCell = getMetaCell(resultCell, "argument", tx);

      const bound = unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        legacyPattern,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
      ) as typeof legacyPattern;
      expect(bound.toJSON).toBe(patternToJSON);
      expect(bound.nodes[0].module.toJSON).toBe(moduleToJSON);
      expect(bound.nodes[0].module.implementation).toBe(implementation);
      expect(findAllWriteRedirectCells(legacyPattern, resultCell)).toEqual([]);
    });
  });

  describe("findAllWriteRedirectCells", () => {
    it("should not find non-unwrapped alias binding", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "single legacy",
        undefined,
        tx,
      );
      testCell.set({ foo: 123 });
      const binding = { $alias: { cell: "result", path: ["foo"] } };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(0);

      const unwrappedBinding = unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        binding,
        testCell.getAsNormalizedFullLink(),
        testCell,
      );
      const unwrappedLinks = findAllWriteRedirectCells(
        unwrappedBinding,
        testCell,
      );
      expect(unwrappedLinks.length).toBe(1);
      expect(unwrappedLinks[0].path).toEqual(["foo"]);
      expect(unwrappedLinks[0].id).toBeDefined();
      expect(unwrappedLinks[0].space).toBe(space);
    });

    it("should ignore deferred legacy aliases", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "deferred legacy aliases",
        undefined,
        tx,
      );
      testCell.set({ foo: 1 });
      const binding = {
        deferredArgument: {
          $alias: { cell: "argument", path: ["foo"], defer: 1 },
        },
        deferredInternal: {
          $alias: { partialCause: "local", path: [], defer: 1 },
        },
        immediate: { $alias: { cell: "result", path: ["foo"] } },
      };

      // Unwrapping converts the immediate alias to a sigil link; the deferred
      // aliases survive as aliases (defer crossed, next level's wiring) and
      // stay invisible to the walker.
      const unwrappedBinding = unwrapOneLevelAndBindtoDoc(
        runtime.cfc,
        binding,
        testCell.getAsNormalizedFullLink(),
        testCell,
      );
      const links = findAllWriteRedirectCells(unwrappedBinding, testCell);
      expect(links.length).toBe(1);
      expect(links[0].path).toEqual(["foo"]);
    });

    it("does not walk into embedded Pattern values", () => {
      // An embedded pattern's sigil links and aliases are its own binding
      // vocabulary, resolved when THAT pattern is instantiated — not reads of
      // the node carrying it.
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "embedded pattern",
        undefined,
        tx,
      );
      testCell.set({ foo: 123 });
      const embeddedPattern = {
        argumentSchema: true,
        resultSchema: {},
        result: {
          doubled: { $alias: { cell: "argument", path: ["x"] } },
        },
        nodes: [{
          module: { type: "javascript" },
          inputs: testCell.key("foo").getAsWriteRedirectLink({
            base: testCell,
          }),
          outputs: {},
        }],
      };
      const binding = {
        template: embeddedPattern,
        direct: testCell.key("foo").getAsWriteRedirectLink({ base: testCell }),
      };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.map((l) => l.path)).toEqual([["foo"]]);
    });

    it("follows a chain of write redirects (redirect -> redirect)", () => {
      const testCell = runtime.getCell<Record<string, unknown>>(
        space,
        "redirect chain",
        undefined,
        tx,
      );
      // Build p -> q -> r, where each of p and q HOLDS a write-redirect (a
      // redirect whose target value is itself a redirect), and r is a plain
      // value. A literal `$alias` in a set() value is resolved on write, so we
      // store real sigil write-redirects via getAsWriteRedirectLink.
      testCell.set({ r: 99 });
      testCell.key("q").set(
        testCell.key("r").getAsWriteRedirectLink({ base: testCell }),
      );
      testCell.key("p").set(
        testCell.key("q").getAsWriteRedirectLink({ base: testCell }),
      );
      // The binding redirects to p; the chain p -> q -> r is followed, stopping
      // at the non-redirect value 99.
      const binding = testCell.key("p").getAsWriteRedirectLink({
        base: testCell,
      });
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.map((l) => l.path)).toEqual([["p"], ["q"], ["r"]]);
    });

    it("does not dive into a non-redirect target to find nested redirects", () => {
      const testCell = runtime.getCell<Record<string, unknown>>(
        space,
        "nested non-redirect target",
        undefined,
        tx,
      );
      testCell.set({ x: 7 });
      // 'a' holds an OBJECT (a non-redirect) that CONTAINS a nested write
      // redirect. Following the `a` redirect stops at that object — we do NOT
      // walk into it, so the nested `inner` redirect is never discovered.
      testCell.key("a").set({
        inner: testCell.key("x").getAsWriteRedirectLink({ base: testCell }),
        plain: 1,
      });
      const binding = testCell.key("a").getAsWriteRedirectLink({
        base: testCell,
      });
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.map((l) => l.path)).toEqual([["a"]]);
    });

    it("resolves a chained redirect relative to its own document, not the base cell", () => {
      // Cross-document chain: the binding (resolved against cellA) redirects to
      // cellB's `mid`, whose value is a *relative* redirect to `x`. That nested
      // redirect must resolve against cellB (the doc it lives in), not cellA. If
      // the recursion re-based onto cellA, the second link would carry cellA's id.
      const cellA = runtime.getCell<Record<string, unknown>>(
        space,
        "xdoc chain A",
        undefined,
        tx,
      );
      const cellB = runtime.getCell<Record<string, unknown>>(
        space,
        "xdoc chain B",
        undefined,
        tx,
      );
      cellB.set({ x: 55 });
      cellB.key("mid").set(
        cellB.key("x").getAsWriteRedirectLink({ base: cellB }),
      );
      const binding = cellB.key("mid").getAsWriteRedirectLink({ base: cellA });
      const links = findAllWriteRedirectCells(binding, cellA);
      const bId = cellB.getAsNormalizedFullLink().id;
      expect(links.map((l) => ({ id: l.id, path: l.path }))).toEqual([
        { id: bId, path: ["mid"] },
        { id: bId, path: ["x"] },
      ]);
    });

    it("should find all write redirect links in an array", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "array legacy",
        undefined,
        tx,
      );
      testCell.set({ arr: [1, 2, 3] });
      const binding = [
        { $alias: { cell: "result", path: ["arr", "0"] } },
        { $alias: { cell: "result", path: ["arr", "1"] } },
        { $alias: { cell: "result", path: ["arr", "2"] } },
      ];
      const links = findAllWriteRedirectCells(
        unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          binding,
          testCell.getAsNormalizedFullLink(),
          testCell,
        ),
        testCell,
      );
      expect(links.length).toBe(3);
      expect(links.map((l) => l.path)).toEqual([
        ["arr", "0"],
        ["arr", "1"],
        ["arr", "2"],
      ]);
    });

    it("should find write redirect links in an object with multiple links", () => {
      const testCell = runtime.getCell<{ x: number; y: number }>(
        space,
        "object legacy",
        undefined,
        tx,
      );
      testCell.set({ x: 1, y: 2 });
      const binding = {
        a: { $alias: { cell: "result", path: ["x"] } },
        b: { $alias: { cell: "result", path: ["y"] } },
        c: 3,
      };
      const links = findAllWriteRedirectCells(
        unwrapOneLevelAndBindtoDoc(
          runtime.cfc,
          binding,
          testCell.getAsNormalizedFullLink(),
          testCell,
        ),
        testCell,
      );
      expect(links.length).toBe(2);
      expect(links.map((l) => l.path)).toEqual([["x"], ["y"]]);
    });

    it("should return empty array if there are no write redirect links", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "no links",
        undefined,
        tx,
      );
      testCell.set({ foo: 1 });
      const binding = { bar: 2 };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(0);
    });

    it("should find write redirect links using sigil format", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "sigil link",
        undefined,
        tx,
      );
      testCell.set({ foo: 99 });
      const links = findAllWriteRedirectCells(
        testCell.key("foo").getAsWriteRedirectLink({ base: testCell }),
        testCell,
      );
      expect(links.length).toBe(1);
      expect(links[0].path).toEqual(["foo"]);
      expect(links[0].id).toBeDefined();
      expect(links[0].space).toBe(space);
    });
  });
});
