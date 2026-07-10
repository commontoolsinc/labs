import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Frame } from "../src/builder/types.ts";
import { byRef, handler, lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { reactive } from "../src/builder/reactive.ts";
import {
  REPLAYABLE_BUILTIN_REFS,
  SUBPATTERN_ARGUMENT_BUILTIN_REFS,
} from "../src/builder/builtin-replayability.ts";
import { registerBuiltins } from "../src/builtins/index.ts";
import { createRef } from "../src/create-ref.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Identity } from "@commonfabric/identity";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/** Finds the derived-internal-cell descriptor for a result-surface key. */
const descriptorFor = (
  factory: { derivedInternalCells?: { partialCause: unknown }[] },
  partialCause: unknown,
): { partialCause: unknown; kind?: string } | undefined =>
  factory.derivedInternalCells?.find((descriptor) =>
    descriptor.partialCause === partialCause
  );

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
    it("mints a kind-salted id with distinct bytes", () => {
      const cause = { the: "cause" };
      const untagged = createRef({}, cause);
      const kinded = createRef({}, cause, { kind: "computed" });
      // The kind's visible form is the URI scheme (`computed:fid1:<hash>`,
      // applied by toURI at the mint site) — the FabricHash tag stays fid1.
      expect(kinded.tag).toBe("fid1");
      expect(untagged.tag).toBe("fid1");
      // The kind is salted into the hash preimage, so even the bytes differ —
      // code comparing bare hashStrings can never alias the two. This is the
      // byte-distinctness backstop now that the tag no longer carries it.
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

    it("keeps cells captured read-only by a handler computed", () => {
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
      // The handler's $ctx schema grants no writable asCell handle anywhere,
      // so the capture cannot be written through — `doubled` stays computed.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
      // The handler's stream output is never tagged (streams are excluded).
      const stream = descriptorFor(testPattern, "onBump");
      expect(stream).toBeDefined();
      expect(stream!.kind).toBeUndefined();
    });

    it("disqualifies handler captures bound through a writable asCell handle", () => {
      const double = lift((x: number) => x * 2);
      const bumpWritable = handler(
        true as const,
        {
          type: "object",
          properties: { target: { type: "number", asCell: ["cell"] } },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, onBump: bumpWritable({ target: doubled }) };
      });
      // A `"cell"` handle in the $ctx schema is write-capable: the handler
      // could write `doubled` non-replayably, so it must not be computed.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("disqualifies captures of a schema-less writable-proxy handler", () => {
      const double = lift((x: number) => x * 2);
      const bumpProxy = handler(
        (_event: unknown, _ctx: { target: number }) => {},
        { proxy: true },
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, onBump: bumpProxy({ target: doubled }) };
      });
      // The legacy writable proxy makes every capture writable — no schema
      // exists to prove otherwise, so all bound roots disqualify.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("disqualifies outputs of unknown builtin refs", () => {
      const rawNode = byRef<number, number>("someRawTarget");
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        out: rawNode(x),
      }));
      // Builtin names fail STRICT: a name missing from
      // REPLAYABLE_BUILTIN_REFS is treated as non-replayable.
      expect(descriptorFor(testPattern, "out")).toBeDefined();
      expect(descriptorFor(testPattern, "out")!.kind).toBeUndefined();
    });

    it("tags sync-builtin (ifElse) outputs as computed", () => {
      const branch = byRef<unknown, number>("ifElse");
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        out: branch([x, 1, 2]),
      }));
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
    });

    it("disqualifies async-builtin (fetchJson) writers and their input roots", () => {
      const double = lift((x: number) => x * 2);
      const fetch = byRef<unknown, unknown>("fetchJson");
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const derived = double(x);
        return { derived, out: fetch({ url: derived }) };
      });
      // The fetch output is not a replayable derivation of its inputs.
      expect(descriptorFor(testPattern, "out")?.kind).toBeUndefined();
      // Non-replayable builtins may write THROUGH their inputs (llmDialog
      // pushes onto its `messages` input), so the bound root disqualifies
      // even though its own writer (the lift) qualifies.
      expect(descriptorFor(testPattern, "derived")).toBeDefined();
      expect(descriptorFor(testPattern, "derived")!.kind).toBeUndefined();
    });

    it("tags map outputs computed but disqualifies its input roots", () => {
      const toList = lift((x: number) => [x]);
      const mapNode = byRef<unknown, number[]>("map");
      const innerOp = pattern<{ element: number }>(({ element }) => ({
        e: element,
      }));
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const list = toList(x);
        return { list, mapped: mapNode({ list, op: innerOp, params: {} }) };
      });
      // The mapping itself replays deterministically...
      expect(descriptorFor(testPattern, "mapped")?.kind).toBe("computed");
      // ...but the op sub-pattern may contain handlers writing the source
      // elements (invisible at this layer), so the list input disqualifies.
      expect(descriptorFor(testPattern, "list")).toBeDefined();
      expect(descriptorFor(testPattern, "list")!.kind).toBeUndefined();
    });

    it("disqualifies roots handed into a sub-pattern; the sub-pattern output stays computed", () => {
      const double = lift((x: number) => x * 2);
      const inner = pattern<{ item: number }>(({ item }) => ({
        echoed: item,
      }));
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, sub: inner({ item: doubled }) };
      });
      // Sub-pattern arguments are writable-by-default aliases and handlers
      // inside the sub-pattern are invisible here — the input disqualifies.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
      // `pattern` WRITERS qualify (instantiation writes converge on replay) —
      // deliberate; flip to disqualifying if that fails in practice.
      expect(descriptorFor(testPattern, "sub")?.kind).toBe("computed");
    });

    it("keeps handle-bearing lifts computed without capture-write analysis", () => {
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
      // Even if the lift writes through the handle, a replayable compute's
      // writes are deterministically reproduced — the output qualifies.
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
      // The captured state cell has no compute writer — untagged, and a
      // qualifying javascript compute's inputs do not disqualify it.
      expect(descriptorFor(testPattern, "st")).toBeDefined();
      expect(descriptorFor(testPattern, "st")!.kind).toBeUndefined();
    });

    it("keeps handle-bearing lifts computed when capture writes are analyzed", () => {
      // captureWritesAnalyzed is exhaustive-write PROVENANCE only — the
      // classifier no longer consults it, and the result matches the
      // unanalyzed sibling above.
      const embedsHandle = lift(
        (_input: unknown) => 0,
        {
          type: "object",
          properties: { c: { type: "number", asCell: ["cell"] } },
        } as const,
        { type: "number" } as const,
        { captureWritesAnalyzed: true },
      );
      const testPattern = pattern<{ x: number }>(() => {
        const st = reactive<number>(5);
        (st as any).for("st");
        return { out: embedsHandle({ c: st }) };
      });
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
      expect(descriptorFor(testPattern, "st")?.kind).toBeUndefined();
    });

    it("keeps lifts with observed capture writes computed", () => {
      const writesThrough = lift(
        (_input: unknown) => 0,
        {
          type: "object",
          properties: { c: { type: "number", asCell: ["cell"] } },
        } as const,
        { type: "number" } as const,
        {
          captureWritesAnalyzed: true,
          materializerWriteInputPaths: [["c"]],
        },
      );
      const testPattern = pattern<{ x: number }>(() => {
        const st = reactive<number>(5);
        (st as any).for("st");
        return { out: writesThrough({ c: st }) };
      });
      // Observed capture writes are still replayable derivations of the
      // inputs: dropping one loses nothing, so the output stays computed.
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
      expect(descriptorFor(testPattern, "st")?.kind).toBeUndefined();
    });

    it("keeps outputs exposed writable on the result surface computed", () => {
      // ACCEPTED consequence of the polarity flip: result-surface exposure no
      // longer disqualifies. An embedder writing through the exposed handle
      // has that write ack-and-dropped on conflict; the derivation
      // re-establishes the value.
      const exposeHandle = lift(
        (x: number) => ({ h: x }),
        { type: "number" } as const,
        {
          type: "object",
          properties: { h: { type: "number", asCell: ["cell"] } },
        } as const,
      );
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        out: exposeHandle(x),
      }));
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
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

  describe("replayability registry cross-check", () => {
    it("covers every builtin name registered by registerBuiltins", () => {
      // registerBuiltins only touches runtime.moduleRegistry.addModuleByRef —
      // record the literal names it registers.
      const registered: string[] = [];
      registerBuiltins(
        {
          moduleRegistry: {
            addModuleByRef: (ref: string) => {
              registered.push(ref);
            },
          },
        } as unknown as Runtime,
      );
      expect(registered.length).toBeGreaterThan(0);

      // Mirror of the doc-listed non-replayables in
      // builder/builtin-replayability.ts (keep the two in sync).
      const documentedNonReplayable: ReadonlySet<string> = new Set([
        "fetchBinary",
        "fetchText",
        "fetchJson",
        "fetchJsonUnchecked",
        "fetchProgram",
        "streamData",
        "llm",
        "llmDialog",
        "compileAndRun",
        "generateObject",
        "generateText",
        "navigateTo",
        "wish",
        "sqliteQuery",
      ]);

      // Every registered builtin must be recorded in the replayability
      // registry: either proven replayable or documented non-replayable.
      const unrecorded = registered.filter((name) =>
        !REPLAYABLE_BUILTIN_REFS.has(name) &&
        !documentedNonReplayable.has(name)
      );
      expect(unrecorded).toEqual([]);

      // No name may be both.
      const contradictory = [...REPLAYABLE_BUILTIN_REFS].filter((name) =>
        documentedNonReplayable.has(name)
      );
      expect(contradictory).toEqual([]);

      // Sub-pattern-argument builtins are a refinement of the replayable set.
      const strayed = [...SUBPATTERN_ARGUMENT_BUILTIN_REFS].filter((name) =>
        !REPLAYABLE_BUILTIN_REFS.has(name)
      );
      expect(strayed).toEqual([]);
    });
  });

  describe("derived internal cell links", () => {
    it("mints computed-scheme ids for computed descriptors", () => {
      const resultCell = runtime.getCell(space, "computed-kind-link-test");
      const kinded = getDerivedInternalCellLink(resultCell, {
        partialCause: "d",
        kind: "computed",
      });
      const untagged = getDerivedInternalCellLink(resultCell, {
        partialCause: "d",
      });
      expect(kinded.id.startsWith("computed:fid1:")).toBe(true);
      expect(untagged.id.startsWith("of:fid1:")).toBe(true);
      // The kind-salted preimage keeps even the hash part distinct — the
      // computed id is never the of: id with a different scheme glued on.
      expect(kinded.id.slice("computed:".length)).not.toBe(
        untagged.id.slice("of:".length),
      );
    });
  });
});
