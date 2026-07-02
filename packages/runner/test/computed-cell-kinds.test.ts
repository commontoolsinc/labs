import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Frame } from "../src/builder/types.ts";
import { byRef, handler, lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { reactive } from "../src/builder/reactive.ts";
import { createRef } from "../src/create-ref.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Identity } from "@commonfabric/identity";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("computed cell kinds", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { computedCellIds: true },
    });
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    // Disposal resets the ambient computed-cell-ids config to its default.
    await runtime?.dispose();
  });

  describe("createRef kind option", () => {
    it("mints a kind-tagged id with distinct bytes", () => {
      const cause = { the: "cause" };
      const untagged = createRef({}, cause);
      const kinded = createRef({}, cause, { kind: "computed" });
      expect(kinded.tag).toBe("fid2:computed");
      expect(untagged.tag).toBe("fid1");
      // The kind is in the preimage too, so even the bytes differ — code
      // comparing bare hashStrings can never alias the two.
      expect(kinded.hashString).not.toBe(untagged.hashString);
    });

    it("mints deterministically", () => {
      const cause = { the: "cause" };
      expect(createRef({}, cause, { kind: "computed" }).toString()).toBe(
        createRef({}, cause, { kind: "computed" }).toString(),
      );
    });
  });

  describe("builder classification", () => {
    it("tags a pure lift output as computed", () => {
      const double = lift((x: number) => x * 2);
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        doubled: double(x),
      }));
      expect(testPattern.derivedInternalCells).toEqual([
        { partialCause: "doubled", kind: "computed" },
      ]);
    });

    it("tags intermediate lift outputs as computed", () => {
      const increment = lift((x: number) => x + 1);
      const double = lift((x: number) => x * 2);
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const intermediate = increment(x);
        return { doubled: double(intermediate) };
      });
      expect(testPattern.derivedInternalCells).toEqual([
        { partialCause: { $generated: 0 }, kind: "computed" },
        { partialCause: "doubled", kind: "computed" },
      ]);
    });

    it("leaves state cells (no compute writer) untagged", () => {
      const double = lift(({ x }: { x: number }) => x * 2);
      const testPattern = pattern<{ x: number }>(() => {
        const x = reactive<number>(1);
        (x as any).for("x");
        return { double: double({ x }) };
      });
      expect(testPattern.derivedInternalCells).toEqual([
        { partialCause: "double", kind: "computed" },
        // `x` is seeded state with no compute writer — never tagged.
        { partialCause: "x", schema: { default: 1 } },
      ]);
    });

    it("disqualifies cells captured by a handler, even read-only", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: { target: { type: "number" } },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, onBump: bump({ target: doubled }) };
      });
      const doubledDescriptor = testPattern.derivedInternalCells?.find((
        descriptor,
      ) => descriptor.partialCause === "doubled");
      expect(doubledDescriptor).toBeDefined();
      expect(doubledDescriptor!.kind).toBeUndefined();
      // The handler's stream output is not tagged either.
      for (const descriptor of testPattern.derivedInternalCells ?? []) {
        if (descriptor.partialCause === "doubled") continue;
        expect(descriptor.kind).toBeUndefined();
      }
    });

    it("disqualifies outputs of non-javascript (ref) nodes", () => {
      const rawNode = byRef<number, number>("someRawTarget");
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        out: rawNode(x),
      }));
      const outDescriptor = testPattern.derivedInternalCells?.find((
        descriptor,
      ) => descriptor.partialCause === "out");
      expect(outDescriptor).toBeDefined();
      expect(outDescriptor!.kind).toBeUndefined();
    });

    it("disqualifies lifts whose argument schema grants cell handles", () => {
      const writeThrough = lift(
        (_input: unknown) => 0,
        {
          type: "object",
          properties: { c: { type: "number", asCell: ["cell"] } },
        } as const,
        { type: "number" } as const,
      );
      const testPattern = pattern<{ x: number }>(() => {
        const st = reactive<number>(5);
        (st as any).for("st");
        return { out: writeThrough({ c: st }) };
      });
      for (const descriptor of testPattern.derivedInternalCells ?? []) {
        // Neither the captured cell (possibly written through the handle)
        // nor the writer's own output qualifies.
        expect(descriptor.kind).toBeUndefined();
      }
    });

    it("mints nothing when the flag is off", async () => {
      // Replace the flag-on runtime from beforeEach with a default one.
      popFrame(frame);
      await runtime.dispose();
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      frame = pushFrame({
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
        runtime,
      });

      const double = lift((x: number) => x * 2);
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        doubled: double(x),
      }));
      expect(testPattern.derivedInternalCells).toEqual([
        { partialCause: "doubled" },
      ]);
    });
  });

  describe("derived internal cell links", () => {
    it("mints kind-tagged ids for computed descriptors", () => {
      const resultCell = runtime.getCell(space, "computed-kind-link-test");
      const kinded = getDerivedInternalCellLink(resultCell, {
        partialCause: "d",
        kind: "computed",
      });
      const untagged = getDerivedInternalCellLink(resultCell, {
        partialCause: "d",
      });
      expect(kinded.id.startsWith("of:fid2:computed:")).toBe(true);
      expect(untagged.id.startsWith("of:fid1:")).toBe(true);
      expect(kinded.id).not.toBe(untagged.id);
    });
  });
});
