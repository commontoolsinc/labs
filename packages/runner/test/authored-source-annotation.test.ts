import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { Source } from "@commonfabric/js-compiler";
import { getComposeBundleSourceMapCallsForTesting } from "@commonfabric/js-compiler/source-map";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Module, Pattern } from "../src/builder/types.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import type { Engine } from "../src/harness/engine.ts";
import { helperInjectionLineOffset } from "../src/harness/engine.ts";
import { transformInjectHelperModule } from "../src/harness/pretransform.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import type { CachedCompiledModule } from "../src/sandbox/module-record-compiler.ts";
import { Runtime } from "../src/runtime.ts";

// `fn.src` reports where a builder artifact's function was AUTHORED. The
// transformer stamps that position into each artifact's
// `__cfBindVerifiedBinding` metadata (behavior spec §17.3) and the engine reads
// it during the post-evaluation provenance walk, so the answer is a
// transform-time constant rather than anything recovered from a stack.

const signer = await Identity.fromPassphrase("test operator");

/**
 * One module exercising every artifact class the transformer annotates. Line
 * numbers are load-bearing: the assertions address authored positions in THIS
 * text, so a line added here moves every expectation below it.
 */
const ARTIFACT_SOURCE = [
  /*  1 */ "import { computed, lift, pattern } from 'commonfabric';",
  /*  2 */ "const inline = lift((n: number) => n * 2);",
  /*  3 */ "export const exported = lift((n: number) => n + 1);",
  /*  4 */ "const referenced = (n: number) => n - 1;",
  /*  5 */ "const viaReference = lift(referenced);",
  /*  6 */ "function declared(n: number) { return n * 3; }",
  /*  7 */ "const viaDeclaration = lift(declared);",
  /*  8 */ "export default pattern<{ value: number }>(({ value }) => {",
  /*  9 */ "  const hoisted = computed(() => (value as number) + 100);",
  /* 10 */ "  return {",
  /* 11 */ "    a: inline(value),",
  /* 12 */ "    b: exported(value),",
  /* 13 */ "    c: viaReference(value),",
  /* 14 */ "    d: viaDeclaration(value),",
  /* 15 */ "    hoisted,",
  /* 16 */ "  };",
  /* 17 */ "});",
].join("\n");

const ARTIFACT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: ARTIFACT_SOURCE }],
};

const HANDLER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { Cell, Default, handler, pattern } from 'commonfabric';",
        "const inc = handler<unknown, { count: Cell<number> }>(",
        "  (_event, { count }) => { count.set(count.get() + 1); },",
        ");",
        "export default pattern<{ count: number | Default<0> }>(({ count }) => {",
        "  return { count, inc: inc({ count }) };",
        "});",
      ].join("\n"),
    },
  ],
};

type DebugAnnotated = { src?: string; name?: string };

/**
 * The authored coordinate of `anchor` on `line` of `source`, spelled the way
 * `fn.src` ends. Derived from the text rather than written out, so an
 * expectation names the construct it means instead of a counted column.
 */
function authoredAt(source: string, line: number, anchor: string): string {
  const text = source.split("\n")[line - 1];
  const col = text.indexOf(anchor);
  if (col < 0) {
    throw new Error(`line ${line} does not contain ${JSON.stringify(anchor)}`);
  }
  return `/main.tsx:${line}:${col}`;
}

/** The implementation of the pattern node whose body preview names `marker`. */
function nodeImplementation(
  patternFactory: unknown,
  marker: string,
): DebugAnnotated {
  const nodes = (patternFactory as Pattern & { nodes: { module: Module }[] })
    .nodes;
  const found = nodes
    .map((node) => node.module.implementation)
    .find((implementation): implementation is (...args: never[]) => unknown =>
      typeof implementation === "function" &&
      (implementation as { preview?: string }).preview?.includes(marker) ===
        true
    );
  if (!found) throw new Error(`no pattern node previews ${marker}`);
  return found as DebugAnnotated;
}

/** The implementation function behind an exported builder factory. */
function exportedImplementation(
  main: unknown,
  exportName: string,
): DebugAnnotated {
  const module = (main as Record<string, Module>)[exportName];
  return module.implementation as DebugAnnotated;
}

const toCached = (
  modules: readonly CacheableModule[],
): CachedCompiledModule[] =>
  modules.map((module) => ({
    identity: module.identity,
    filename: module.filename,
    code: module.js,
    imports: module.imports,
  }));

describe("authored source annotation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const makeRuntime = (): Engine => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    return runtime.harness;
  };

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("fn.src by artifact class", () => {
    it("reports the authored position and name of an exported builder const", async () => {
      const engine = makeRuntime();
      const { main } = await engine.compileAndEvaluateModules(
        ARTIFACT_PROGRAM,
      );
      const exported = exportedImplementation(main, "exported");

      expect(exported.src).toMatch(/^cf:module\//);
      expect(
        exported.src?.endsWith(
          authoredAt(ARTIFACT_SOURCE, 3, "(n: number) => n + 1"),
        ),
      ).toBe(true);
      expect(exported.name).toBe("exported");
    });

    it("reports the authored position of an in-place non-exported builder const", async () => {
      // Never exported, so it reaches the provenance walk through its
      // `__cfReg` registration rather than through a namespace.
      const engine = makeRuntime();
      const { main } = await engine.compileAndEvaluateModules(
        ARTIFACT_PROGRAM,
      );
      const inline = nodeImplementation(
        (main as { default?: unknown }).default,
        "n * 2",
      );

      expect(
        inline.src?.endsWith(
          authoredAt(ARTIFACT_SOURCE, 2, "(n: number) => n * 2"),
        ),
      ).toBe(true);
      expect(inline.name).toBe("inline");
    });

    it("reports the authored position of a lift hoisted out of a pattern body", async () => {
      const engine = makeRuntime();
      const { main } = await engine.compileAndEvaluateModules(
        ARTIFACT_PROGRAM,
      );
      const hoisted = nodeImplementation(
        (main as { default?: unknown }).default,
        "value + 100",
      );

      expect(
        hoisted.src?.endsWith(
          authoredAt(ARTIFACT_SOURCE, 9, "() => (value as number) + 100"),
        ),
      ).toBe(true);
      // The hoisted const is `__cfLift_N`; the name the author would recognize
      // survives only in the annotation.
      expect(hoisted.name).toBe("hoisted");
    });

    it("reports the authored position of an export-default pattern, unnamed", async () => {
      const engine = makeRuntime();
      const { main } = await engine.compileAndEvaluateModules(
        ARTIFACT_PROGRAM,
      );
      // A pattern factory carries no `.implementation`, so it is itself what
      // the provenance walk records and what serves `src`.
      const patternFactory = (main as { default?: DebugAnnotated }).default!;

      expect(
        patternFactory.src?.endsWith(
          authoredAt(ARTIFACT_SOURCE, 8, "({ value }) => {"),
        ),
      ).toBe(true);
      // `export default` binds no name, and the declaration a pattern is
      // assigned to would not name what is written inside its callback.
      expect(patternFactory.name).toBe("");
    });

    it("reports where a referenced callback was written, under its own name", async () => {
      const engine = makeRuntime();
      const { main } = await engine.compileAndEvaluateModules(
        ARTIFACT_PROGRAM,
      );
      const viaReference = nodeImplementation(
        (main as { default?: unknown }).default,
        "n - 1",
      );

      // The position names the callback's own declaration, not the builder
      // binding that consumed it.
      expect(
        viaReference.src?.endsWith(
          authoredAt(ARTIFACT_SOURCE, 4, "(n: number) => n - 1"),
        ),
      ).toBe(true);
      expect(viaReference.name).toBe("referenced");
    });

    // ANCHOR-LESS artifacts have no case here. The transformer annotates a
    // builder whose callback arrives through property access or an import at
    // the builder call's own site, but the SES compiled-bundle verifier refuses
    // to load a module containing one — `resolveTrustedBuilderCallback` admits
    // a direct function or a same-file identifier bound to one, and nothing
    // else ("must receive a direct callback, not an indirect reference",
    // pinned by esm-verifier-parity.test.ts). Such an artifact therefore never
    // reaches the provenance walk, so it has no `fn.src` to assert. Add a case
    // here if that rule is ever relaxed.

    it("reports a declaration-form callback at its declaration", async () => {
      const engine = makeRuntime();
      const { main } = await engine.compileAndEvaluateModules(
        ARTIFACT_PROGRAM,
      );
      const viaDeclaration = nodeImplementation(
        (main as { default?: unknown }).default,
        "n * 3",
      );

      expect(
        viaDeclaration.src?.endsWith(
          authoredAt(ARTIFACT_SOURCE, 6, "function declared"),
        ),
      ).toBe(true);
      expect(viaDeclaration.name).toBe("declared");
    });

    it("resolves a handler's src to its authored source, not a bundle coordinate", async () => {
      makeRuntime();
      const compiled = await runtime.patternManager.compilePattern(
        HANDLER_PROGRAM,
      );
      const handlerModule = (compiled as Pattern & {
        nodes: { module: Module }[];
      }).nodes
        .map((node) => node.module)
        .find((module) =>
          module.type === "javascript" && module.wrapper === "handler" &&
          typeof module.implementation === "function"
        );
      expect(handlerModule).toBeDefined();
      const implementation = handlerModule!.implementation as DebugAnnotated;

      expect(implementation.src).toMatch(/^cf:module\//);
      expect(implementation.src).toMatch(/(?:^|\/)main\.tsx:\d+:\d+$/);
      expect(implementation.src).not.toMatch(/:esm:|\.js:\d+:\d+$/);
      // The debug position is independent of policy-facing identity, which
      // resolves through the provenance record.
      expect(
        resolvePolicyFacingImplementationIdentity(handlerModule!, {
          implementation: implementation as never,
        })?.kind,
      ).toBe("verified");
    });
  });

  describe("helper-injection line offset", () => {
    // The transformer's position indexes the file the pipeline transformed,
    // which is the authored file plus the one-line helper-import prelude the
    // pre-transform injects. The engine applies that file's offset EXACTLY
    // ONCE. Both arms are needed: a file that gets the prelude catches a
    // missing correction, and one that does not catches a doubled one.

    it("subtracts the injected prelude from an authored file's position", async () => {
      expect(helperInjectionLineOffset(ARTIFACT_SOURCE)).toBe(-1);

      const engine = makeRuntime();
      const { main } = await engine.compileAndEvaluateModules(
        ARTIFACT_PROGRAM,
      );

      expect(
        exportedImplementation(main, "exported").src?.endsWith(
          authoredAt(ARTIFACT_SOURCE, 3, "(n: number) => n + 1"),
        ),
      ).toBe(true);
    });

    it("leaves the position alone for a file that receives no prelude", async () => {
      const engine = makeRuntime();
      // Compile once so the deferred compiler stack is loaded, then take the
      // helper-injected form as the module's source of record: its own bytes
      // already carry the prelude, so nothing shifts its lines.
      await engine.compileToRecordGraph(ARTIFACT_PROGRAM);
      const envelope =
        transformInjectHelperModule(ARTIFACT_PROGRAM).files[0].contents;
      expect(helperInjectionLineOffset(envelope)).toBe(0);

      const storedSource: Source[] = [{
        name: "/main.tsx",
        contents: envelope,
      }];
      const recovered = await engine.compileResolvedToRecordGraph(
        storedSource,
        "/main.tsx",
      );
      const { main } = await engine.evaluateCachedModules(
        toCached(recovered.modules),
        recovered.entryIdentity,
        { sourceFiles: storedSource },
      );

      // The construct sits one line lower in this file, and that is exactly
      // where `src` addresses it.
      expect(
        exportedImplementation(main, "exported").src?.endsWith(
          authoredAt(envelope, 4, "(n: number) => n + 1"),
        ),
      ).toBe(true);
    });
  });

  describe("cached loads", () => {
    it("resolves authored positions from cached bodies when the sources come along", async () => {
      const engine = makeRuntime();
      const { modules, entryIdentity } = await engine.compileToRecordGraph(
        ARTIFACT_PROGRAM,
      );

      const { main } = await engine.evaluateCachedModules(
        toCached(modules),
        entryIdentity,
        { sourceFiles: ARTIFACT_PROGRAM.files },
      );

      expect(
        exportedImplementation(main, "exported").src?.endsWith(
          authoredAt(ARTIFACT_SOURCE, 3, "(n: number) => n + 1"),
        ),
      ).toBe(true);
    });

    it("omits src on a source-free load, keeping the authored name", async () => {
      // A by-identity warm load carries no source, so the injection offset for
      // the module is unknown. A position that might be off by one is worse
      // than none, so `src` is absent — the name still comes from the
      // annotation the cached body carries.
      const engine = makeRuntime();
      const { modules, entryIdentity } = await engine.compileToRecordGraph(
        ARTIFACT_PROGRAM,
      );

      const { main } = await engine.evaluateCachedModules(
        toCached(modules),
        entryIdentity,
        {},
      );
      const exported = exportedImplementation(main, "exported");

      expect(exported.src).toBeUndefined();
      expect(exported.name).toBe("exported");
    });
  });

  describe("source-map composition", () => {
    it("composes no source maps while evaluating a pattern", async () => {
      // CT-1819: the maps registered during evaluation serve error mapping
      // only, and composing one is a per-segment VLQ transcode over every
      // module. Nothing at boot asks for a position, so nothing composes.
      makeRuntime();
      const before = getComposeBundleSourceMapCallsForTesting();
      const compiled = await runtime.patternManager.compilePattern(
        HANDLER_PROGRAM,
      );
      expect(compiled).toBeDefined();
      expect(getComposeBundleSourceMapCallsForTesting()).toBe(before);
    });
  });
});
