import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
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
  isLegacyAlias,
  parseLink,
} from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCell } from "../src/cell.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

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
        expect(isLegacyAlias(nameBinding)).toBe(true);
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
  });

  describe("findAllWriteRedirectCells", () => {
    it("should find a single legacy alias binding", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "single legacy",
        undefined,
        tx,
      );
      testCell.set({ foo: 123 });
      const binding = { $alias: { path: ["foo"] } };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(1);
      expect(links[0].path).toEqual(["foo"]);
      expect(links[0].id).toBeDefined();
      expect(links[0].space).toBe(space);
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
        { $alias: { path: ["arr", "0"] } },
        { $alias: { path: ["arr", "1"] } },
        { $alias: { path: ["arr", "2"] } },
      ];
      const links = findAllWriteRedirectCells(binding, testCell);
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
        a: { $alias: { path: ["x"] } },
        b: { $alias: { path: ["y"] } },
        c: 3,
      };
      const links = findAllWriteRedirectCells(binding, testCell);
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
        immediate: { $alias: { path: ["foo"] } },
      };

      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(1);
      expect(links[0].path).toEqual(["foo"]);
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
