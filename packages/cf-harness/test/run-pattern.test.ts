import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { isSealedOpaqueLinkObject } from "../src/structured-result.ts";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import {
  asSerializableValue,
  RUN_PATTERN_MAX_SOURCE_TEXT_BYTES,
  type RunPatternToolErrorOutput,
  type RunPatternToolInput,
  type RunPatternToolSuccessOutput,
} from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness run-pattern tool");

const DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

const NAMED_DOUBLING_PATTERN_SOURCE = [
  "import { computed, NAME, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; $NAME: string; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  [NAME]: 'Doubler',",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/** A pattern whose single input is an object, for the plain-JSON cases. */
const OVERVIEW_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Overview { title: string; }",
  "interface Input { overview: Overview; }",
  "interface Output { titleLength: number; }",
  "export default pattern<Input, Output>(({ overview }) => ({",
  "  titleLength: computed(() => overview.title.length),",
  "}));",
  "",
].join("\n");

const TITLE_LENGTH_RESULT_SCHEMA = {
  type: "object",
  properties: { titleLength: { type: "number" } },
  required: ["titleLength"],
} as const;

/**
 * What a `resultSchema`-sanitized result carries at a position it sealed:
 * the single-key `@link` object over an `opaque:` target. A model reading a
 * tool result can copy one of these back out, which is what the sealed-input
 * refusal exists for.
 */
const SEALED_OPAQUE_LINK = {
  "@link": "opaque:run-pattern-test%3Arun_pattern%3A1#/overview",
} as const;

/**
 * The same seal without its `@link` wrapper. A model reading a sanitized
 * result can lift the target string out and pass it on its own, which reaches
 * an input at any position the argument schema admits a string.
 */
const SEALED_OPAQUE_TARGET = SEALED_OPAQUE_LINK["@link"];

/**
 * A pattern whose argument schema carries an index signature, so
 * `additionalProperties` is a schema: undeclared keys are permitted, and their
 * values are what that schema describes.
 */
const OPEN_DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; [key: string]: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/**
 * A pattern whose argument schema admits any undeclared key without saying
 * what it may hold, so `additionalProperties` is `true`.
 */
const ANY_DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "// deno-lint-ignore no-explicit-any",
  "interface Input { n: number; [key: string]: any; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/** A pattern whose single input is an array, for the nested-position cases. */
const ROW_COUNT_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { rows: string[]; }",
  "interface Output { rowCount: number; }",
  "export default pattern<Input, Output>(({ rows }) => ({",
  "  rowCount: computed(() => rows.length),",
  "}));",
  "",
].join("\n");

const ROW_COUNT_RESULT_SCHEMA = {
  type: "object",
  properties: { rowCount: { type: "number" } },
  required: ["rowCount"],
} as const;

/** A pattern whose single input is a string, for the link-shaped-string case. */
const LABEL_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { label: string; }",
  "interface Output { labelLength: number; }",
  "export default pattern<Input, Output>(({ label }) => ({",
  "  labelLength: computed(() => label.length),",
  "}));",
  "",
].join("\n");

const LABEL_LENGTH_RESULT_SCHEMA = {
  type: "object",
  properties: { labelLength: { type: "number" } },
  required: ["labelLength"],
} as const;

const DOUBLED_RESULT_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const;

/**
 * A minimal default-pattern program exposing the piece registry, so the
 * space has a REAL registry rather than the detached always-empty fallback.
 */
const DEFAULT_PATTERN_SOURCE = [
  "/// <cf-disable-transform />",
  "import { handler, pattern, type Cell } from 'commonfabric';",
  "const addPiece = handler<{ piece: unknown }, { pieceRegistry: Cell<unknown[]> }>(",
  "  true,",
  "  { type: 'object', properties: { pieceRegistry: { type: 'array', asCell: ['cell'] } } },",
  "  ({ piece }, { pieceRegistry }) => {",
  "    pieceRegistry.push(piece);",
  "  },",
  ");",
  "export default pattern<{ pieceRegistry: unknown[] }>(({ pieceRegistry }) => ({",
  "  pieceRegistry,",
  "  addPiece: addPiece({ pieceRegistry }),",
  "}));",
].join("\n");

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("run-pattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function createEngine() {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `run-pattern-test-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
  }

  /** Counts `runPersistent` calls, the single path that persists a piece. */
  function spyOnRunPersistent(): { calls: number } {
    const spy = { calls: 0 };
    const original = pieces.runPersistent.bind(pieces);
    pieces.runPersistent = ((
      ...args: Parameters<
        PiecesController["runPersistent"]
      >
    ) => {
      spy.calls += 1;
      return original(...args);
    }) as PiecesController["runPersistent"];
    return spy;
  }

  describe("runPatternTool", () => {
    it("runs inline `sourceText` and returns a `resultRef` with the sanitized `value`", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.resultRef).toMatch(/^\/of:/);
      expect(output.pieceId.length).toBeGreaterThan(0);
      expect((output.value as { doubled: number }).doubled).toBe(42);
      expect(output.linkedStringCount).toBe(0);
    });

    it("returns a sealed string position as the address of that position rather than an opaque link", async () => {
      // The schema declares `label` as an unconstrained string, which the
      // sanitizer withholds as text. The result is fabric-backed, so the
      // withheld position goes over as a whole `@link` object addressing it
      // — resultRef plus the sealed path — which the outbound swap mints
      // into a token in one piece, whitespace in property names and all. Foreign seals are a different thing and stay
      // refused at input; only seals this sanitization minted are addressed.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Input { n: number; }",
          "interface Output { doubled: number; label: string; }",
          "export default pattern<Input, Output>(({ n }) => ({",
          "  doubled: computed(() => n * 2),",
          "  label: computed(() => `doubled ${n}`),",
          "}));",
          "",
        ].join("\n"),
        inputs: { n: 21 },
        resultSchema: {
          type: "object",
          properties: {
            doubled: { type: "number" },
            label: { type: "string" },
          },
          required: ["doubled", "label"],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      const value = output.value as { doubled: number; label: string };
      expect(value.doubled).toBe(42);
      expect(value.label).toEqual({ "@link": `${output.resultRef}/label` });
      expect(output.linkedStringCount).toBe(1);
    });

    it("addresses a sealed property whose name carries whitespace without truncating the path", async () => {
      // "full name" is a valid JSON key the free-text scanner would cut an
      // address short at; the whole `@link` object keeps it in one piece.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Input { n: number; }",
          "interface Output { 'full name': string; }",
          "export default pattern<Input, Output>(({ n }) => ({",
          "  'full name': computed(() => `holder ${n}`),",
          "}));",
          "",
        ].join("\n"),
        inputs: { n: 3 },
        resultSchema: {
          type: "object",
          properties: { "full name": { type: "string" } },
          required: ["full name"],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as Record<string, unknown>)["full name"]).toEqual({
        "@link": `${output.resultRef}/full name`,
      });
    });

    it("keeps the seal for a property the link grammar cannot round-trip", async () => {
      // An empty property name is valid JSON, but its address serializes
      // with a trailing slash the link parse discards — the reference would
      // name the parent. The position keeps its seal instead.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Input { n: number; }",
          "interface Output { '': string; }",
          "export default pattern<Input, Output>(({ n }) => ({",
          "  '': computed(() => `anon ${n}`),",
          "}));",
          "",
        ].join("\n"),
        inputs: { n: 5 },
        resultSchema: {
          type: "object",
          properties: { "": { type: "string" } },
          required: [""],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      const sealed = (output.value as Record<string, unknown>)[""];
      expect(isSealedOpaqueLinkObject(sealed)).toBe(true);
    });

    it("returns a structured error for a plain-function pattern whose compiled argument schema is undefined, rather than throwing out of the run", async () => {
      const engine = createEngine();
      // A bare default function compiles to a pattern with no argument
      // schema at all — not even the boolean schema `pattern()` synthesizes
      // — so the undeclared-input check must not assume one exists. The
      // source itself is not a runnable pattern; what this pins is that its
      // failure comes back as a tool output the model can read and correct.
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          'export const NAME = "Probe";',
          "export default function({}: {}) { return { ok: true }; }",
          "",
        ].join("\n"),
      });
      const output = result.output as { status: string; message?: string };
      expect(output.status).toBe("error");
      expect((output.message ?? "").length).toBeGreaterThan(0);
    });

    it("keeps a computed number when the result carries framework keys the schema does not declare", async () => {
      // Every pattern result carries the framework's own keys, and a schema
      // describing only what the pattern computes declares none of them. The
      // sanitizer seals a whole object over one unmodeled key, so without the
      // framework keys being dropped first the number goes over as an opaque
      // link along with everything else.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.rawValue as Record<string, unknown>)["$NAME"]).toBe(
        "Doubler",
      );
      expect(output.value).toEqual({ doubled: 42 });
      expect(output.linkedStringCount).toBe(0);
    });

    it("refuses a result the schema rejects for what it carries under a framework key", async () => {
      // The raw result is what the schema measures. A branch that asks what
      // `$NAME` holds gets the answer the pattern gave, so a result that does
      // not match is refused — projecting the framework keys out before
      // validating would hand the branch the rest of the result and accept it.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: {
          oneOf: [{
            type: "object",
            properties: {
              doubled: { type: "number" },
              $NAME: { type: "string", const: "Approved" },
            },
            required: ["doubled", "$NAME"],
          }],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toBeUndefined();
      expect(output.valueError).toBeDefined();
    });

    it("keeps a framework key the schema declares through a composed branch", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: {
          oneOf: [{
            type: "object",
            properties: {
              doubled: { type: "number" },
              $NAME: { type: "string", const: "Doubler" },
            },
            required: ["doubled", "$NAME"],
          }],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42, $NAME: "Doubler" });
    });

    it("passes a whole-string LLM-friendly link input as a live cell reference", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell<number>(space, "run-pattern-seed", {
        type: "number",
      });
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set(7);
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: seedRef },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(14);
    });

    it("stores a by-reference input as a link, so the created piece's argument follows the referenced cell", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell<number>(space, "run-pattern-wired-seed", {
        type: "number",
      });
      const seeded = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set(7);
      });
      expect(seeded.error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: seedRef },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");

      // The created piece's argument reads back as the referenced cell's
      // value, at the key the pattern declares.
      const piece = await pieces.get(output.pieceId);
      expect(await piece.input.get(["n"])).toBe(7);

      // And it holds the reference rather than a copy of what the reference
      // pointed at when the piece was created: a later write to the seed
      // reaches the piece's result.
      const rewritten = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set(10);
      });
      expect(rewritten.error).toBeUndefined();
      await runtime.idle();
      await pieces.synced();
      expect(await piece.result.get(["doubled"])).toBe(20);
    });

    it("returns an error naming the failing computation when the result settles to nothing", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Output { boom: number; }",
          "export default pattern<Record<string, never>, Output>(() => ({",
          "  boom: computed(() => { throw new Error('boom in lift'); }),",
          "}));",
          "",
        ].join("\n"),
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("failed while settling");
      // The thrown text is a data channel: it stays in the artifact field the
      // prompt loop strips from model context, never in the message.
      expect(output.message).not.toContain("boom in lift");
      expect(output.rawCauseMessage).toContain("boom in lift");
      expect(output.pieceId).toBeDefined();
      expect(result.runState.status).toBe("completed");
    });

    it("returns an error naming deferred writes when a policy-refused commit keeps the result from landing", async () => {
      // A strict flow-label runtime over a labelled source: the pattern's
      // description-derived write is refused at the commit boundary, the
      // scheduler retries it past the convergence budget, and the result
      // settles to nothing. The tool reports that as an error naming the
      // deferred-writes shape rather than an ok over an empty value.
      const strictStorage = StorageManager.emulate({ as: signer });
      const strictRuntime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: strictStorage,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      const strictPieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `run-pattern-strict-${crypto.randomUUID()}`,
        }),
        strictRuntime,
      );
      try {
        await strictPieces.synced();
        const space = strictPieces.getSpace();
        const seed = strictRuntime.edit();
        const sourceCell = strictRuntime.getCell(
          space,
          "labelled-source",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
              amount: { type: "number" },
            },
          },
          seed,
        );
        const sourceId = sourceCell.getAsNormalizedFullLink().id;
        seed.writeOrThrow({ space, scope: "space", id: sourceId, path: [] }, {
          value: { secret: "s3cr3t", amount: 2 },
          cfc: {
            version: 1,
            schemaHash: "seed-schema",
            labelMap: {
              version: 1,
              entries: [{
                path: ["secret"],
                label: { confidentiality: ["secret"] },
              }],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();
        const sourceRef = createLLMFriendlyLink(
          sourceCell.getAsNormalizedFullLink(),
          space,
        );

        const engine = new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: `run-pattern-strict-${crypto.randomUUID()}`,
          cfcEnforcementMode: "disabled",
          fabricSessionFactory: () => Promise.resolve({ pieces: strictPieces }),
        });
        const result = await engine.invokeBuiltinTool("run_pattern", {
          sourceText: [
            "import { computed, pattern, Reactive } from 'commonfabric';",
            "interface Source { secret: string; amount: number; }",
            "interface Input { source: Reactive<Source>; }",
            "interface Output { copied: string; }",
            "export default pattern<Input, Output>(({ source }) => ({",
            "  copied: computed(() => `${source.secret}!`),",
            "}));",
            "",
          ].join("\n"),
          inputs: { source: sourceRef },
        });
        const output = result.output as RunPatternToolErrorOutput;
        expect(output.status).toBe("error");
        expect(output.message).toContain("result never landed");
        expect(output.message).toContain("convergence budget");
        expect(output.pieceId).toBeDefined();
      } finally {
        await strictRuntime.dispose();
        await strictStorage.close();
      }
    });

    it("returns a `compile-error` output carrying the raw diagnostics without failing the run", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: "this is not a pattern ((",
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("compile-error");
      expect(output.message.length).toBeGreaterThan(0);
      expect(result.runState.status).toBe("completed");
    });

    it("returns an error when `sourceText` is missing", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {});
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires sourceText");
    });

    it("returns an error for a `sourceText` over the size cap without creating a piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: "x".repeat(RUN_PATTERN_MAX_SOURCE_TEXT_BYTES + 1),
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("256 KiB limit");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for a link input targeting another space without creating a piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const foreignRef = `/@did:key:z6MkforeignSpaceForRunPatternTest/of:fid1:${
        "A".repeat(43)
      }/`;
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: foreignRef },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("targets another space");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for a live-cell input whose value does not match the argument schema, creating no piece", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell(
        space,
        "run-pattern-shape-mismatch",
        {
          type: "object",
          properties: { foo: { type: "number" } },
        } as const,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set({ foo: 1 });
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: seedRef },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "n"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming an input the pattern's argument schema does not declare, creating no piece", async () => {
      // A misnamed input is the mismatch a shape check cannot see: the
      // pattern runs with its argument undefined, computes nothing from it,
      // and renders a complete page holding no values. Refusing before the
      // piece exists turns that into something the model can correct.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { count: 21 },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('"count"');
      expect(output.message).toContain('it declares "n"');
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming an input that is a sealed opaque link, creating no piece", async () => {
      // A seal is a redaction, so storing it would leave a dead literal where
      // the pattern declared a live reference: the piece would run, compute
      // nothing from that argument, and report `ok`.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: SEALED_OPAQUE_LINK },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "n"');
      expect(output.message).toContain("sealed opaque link");
      expect(output.message).toContain("redaction, not an address");
      expect(output.message).toContain("cfh:a:");
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming the path of a sealed opaque link nested inside an object input, creating no piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OVERVIEW_PATTERN_SOURCE,
        inputs: { overview: { title: SEALED_OPAQUE_LINK } },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "overview"');
      expect(output.message).toContain('at "overview.title"');
      expect(output.message).toContain("redaction, not an address");
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming the path of a bare seal target string nested inside an object input, creating no piece", async () => {
      // The seal is the `opaque:` target, not the object it arrived in. Lifted
      // out of that object it reaches any position the argument schema admits
      // a string — here `overview.title`, which the pattern declares as one —
      // and it is the same redaction there.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OVERVIEW_PATTERN_SOURCE,
        inputs: { overview: { title: SEALED_OPAQUE_TARGET } },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "overview"');
      expect(output.message).toContain('at "overview.title"');
      expect(output.message).toContain("redaction, not an address");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for an `@link` object carrying a seal target alongside another key, creating no piece", async () => {
      // A model that copied the seal out along with a sibling key it wrote
      // itself still passed back the redaction; the wrapper's shape is not
      // what makes it one.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OVERVIEW_PATTERN_SOURCE,
        inputs: {
          overview: { "@link": SEALED_OPAQUE_TARGET, note: "the overview" },
        },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      // The object itself is the seal, so the refusal names the input rather
      // than a path to the `@link` key inside it.
      expect(output.message).toContain(
        'input "overview" is a sealed opaque link',
      );
      expect(output.message).toContain("redaction, not an address");
      expect(spy.calls).toBe(0);
    });

    it("runs an input the argument schema admits through an `additionalProperties` schema rather than by name", async () => {
      // An `additionalProperties` schema is an index signature: it permits the
      // undeclared key and says what it may hold. Refusing such a key would
      // reject an input the pattern's own schema accepts.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OPEN_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: 5 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42 });
    });

    it("returns an error for an undeclared input whose value the `additionalProperties` schema rejects, creating no piece", async () => {
      // The test above is this one's control: the same pattern accepts the
      // same undeclared key when its value is what `additionalProperties`
      // describes. Admitting an undeclared key is a statement about what it
      // may hold, so the value is still measured — against that schema rather
      // than against a declared property's.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OPEN_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: "five" },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "offset"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for an undeclared live-cell input whose value the `additionalProperties` schema rejects, creating no piece", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell(
        space,
        "run-pattern-open-seed",
        {
          type: "string",
        } as const,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set("five");
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OPEN_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: seedRef },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "offset"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming the position of a sealed opaque link inside an array input, creating no piece", async () => {
      // A model composes an input out of what an earlier result handed it, and
      // an array is one of the shapes it composes. The seal is the same
      // redaction at index 1 of a list as it is at the top of an input.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ROW_COUNT_PATTERN_SOURCE,
        inputs: { rows: ["first", SEALED_OPAQUE_TARGET] },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "rows"');
      expect(output.message).toContain('at "rows[1]"');
      expect(output.message).toContain("redaction, not an address");
      expect(spy.calls).toBe(0);
    });

    it("runs an array input whose entries carry no sealed opaque link", async () => {
      // The control for the case above: the same pattern and the same shape of
      // input, so the refusal there is the seal rather than the array.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ROW_COUNT_PATTERN_SOURCE,
        inputs: { rows: ["first", "second"] },
        resultSchema: ROW_COUNT_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ rowCount: 2 });
    });

    it("keeps a link-shaped string that does not parse as a link as the input's plain value", async () => {
      // A string can wear the shape of an LLM-friendly link without being one:
      // this one carries a piece handle too short to be a fabric identifier. It
      // is the input's value, not a reference, so the pattern computes over the
      // string itself.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: LABEL_PATTERN_SOURCE,
        inputs: { label: "/of:fid1:short/x" },
        resultSchema: LABEL_LENGTH_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ labelLength: "/of:fid1:short/x".length });
      const piece = await pieces.get(output.pieceId);
      expect(await piece.input.get(["label"])).toBe("/of:fid1:short/x");
    });

    it("runs an undeclared input the argument schema admits without saying what it may hold", async () => {
      // `additionalProperties: true` states that an undeclared key is
      // permitted and nothing about its value, so there is no schema to
      // measure it against and no shape it can fail.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ANY_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: "five" },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42 });
      const piece = await pieces.get(output.pieceId);
      expect(await piece.input.get(["offset"])).toBe("five");
    });

    it("runs an undeclared live-cell input the argument schema admits without saying what it may hold", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell(
        space,
        "run-pattern-any-seed",
        {
          type: "string",
        } as const,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set("five");
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ANY_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: seedRef },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42 });
      const piece = await pieces.get(output.pieceId);
      expect(await piece.input.get(["offset"])).toBe("five");
    });

    it("returns an error for a plain-JSON input whose value does not match the argument schema, creating no piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: "twenty-one" },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "n"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("runs a plain-JSON object input that matches its declared argument schema", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OVERVIEW_PATTERN_SOURCE,
        inputs: { overview: { title: "Weekly" } },
        resultSchema: TITLE_LENGTH_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ titleLength: 6 });
    });

    it("returns a `cancelled` output when the signal aborts while the settle race is underway", async () => {
      // The abort lands after the race over the settle barrier has been
      // entered — a microtask later, not before — so the live race path
      // itself answers, rather than the pre-aborted short-circuit.
      const controller = new AbortController();
      const runtimeWithSettled = runtime as unknown as {
        settled: () => Promise<void>;
      };
      runtimeWithSettled.settled = () => {
        queueMicrotask(() => controller.abort());
        return new Promise<void>(() => {});
      };
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      }, { signal: controller.signal });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("cancelled");
    });

    it("serializes a plain value and answers undefined for one JSON cannot carry", () => {
      expect(asSerializableValue({ n: 1 })).toEqual({ n: 1 });
      expect(asSerializableValue(7n)).toBeUndefined();
    });

    it("returns a `cancelled` output and stops the piece when the signal aborts during the settle barrier", async () => {
      const controller = new AbortController();
      // Abort exactly when the tool reaches its post-create barrier, and
      // hold the barrier open so only the signal can win the race.
      const runtimeWithSettled = runtime as unknown as {
        settled: () => Promise<void>;
      };
      runtimeWithSettled.settled = () => {
        controller.abort();
        return new Promise<void>(() => {});
      };
      const stopped: unknown[] = [];
      const runner = runtime.runner as unknown as {
        stop: (cell: unknown) => unknown;
      };
      const originalStop = runner.stop.bind(runtime.runner);
      runner.stop = (cell) => {
        stopped.push(cell);
        return originalStop(cell);
      };
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      }, { signal: controller.signal });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("cancelled");
      expect(output.message).toContain("cancelled");
      expect(stopped.length).toBe(1);
      expect(result.runState.status).toBe("completed");
    });

    it("surfaces a rejected session construction as a structured error and invokes the factory again on the next call", async () => {
      let factoryCalls = 0;
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `run-pattern-test-${crypto.randomUUID()}`,
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () => {
          factoryCalls += 1;
          return Promise.reject(
            new Error("authorization denied for the configured space"),
          );
        },
      });
      const first = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
      });
      const firstOutput = first.output as RunPatternToolErrorOutput;
      expect(firstOutput.status).toBe("error");
      expect(firstOutput.message).toContain("fabric session unavailable");
      expect(firstOutput.message).toContain("authorization denied");
      const second = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
      });
      expect((second.output as RunPatternToolErrorOutput).status).toBe(
        "error",
      );
      expect(factoryCalls).toBe(2);
    });

    it("leaves the created piece out of the space's real registered piece list", async () => {
      // A real default pattern first: without one, `getRegisteredPieces()`
      // reads a detached always-empty fallback and the assertion below
      // holds vacuously.
      const defaultRoot = await pieces.create(DEFAULT_PATTERN_SOURCE, {
        input: { pieceRegistry: [] },
      });
      await pieces.linkDefaultPattern(defaultRoot.getCell());
      await runtime.idle();
      await pieces.synced();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      });
      expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.length).toBe(0);
      // The registry observes registration, proving the zero above is a
      // decision by the tool and not an inert list.
      const control = await pieces.create(DOUBLING_PATTERN_SOURCE, {
        input: { n: 2 },
      });
      await pieces.add([control.getCell()]);
      const afterAdd = await pieces.getRegisteredPieces();
      expect(afterAdd.length).toBe(1);
    });

    it("returns a `cancelled` output without creating a piece when the signal is already aborted", async () => {
      const spy = spyOnRunPersistent();
      const controller = new AbortController();
      controller.abort();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      }, { signal: controller.signal });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("cancelled");
      expect(output.message).toContain("cancelled");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for a `resultSchema` that is not a JSON Schema, creating no piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
        resultSchema: "{ not json",
      } as unknown as RunPatternToolInput);
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain(
        "resultSchema string must be valid JSON",
      );
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming the configuration a run without a fabric session is missing", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `run-pattern-test-${crypto.randomUUID()}`,
        cfcEnforcementMode: "disabled",
      });
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires a fabric session");
      expect(output.message).toContain("--fabric-space");
    });
  });
});
