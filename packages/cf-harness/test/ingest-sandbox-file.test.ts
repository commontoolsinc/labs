/**
 * The sandbox round trip's return half: which label a cell minted from
 * sandbox output carries, which sources that label may come from, and the two
 * things that have to hold before it means anything — that this run family
 * produced the file, and that the family can still account for everything its
 * sandbox did.
 */

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import type { CfcSandboxResult, IFCLabel } from "@commonfabric/runner/cfc";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  SANDBOX_OUTPUT_DIR_ENV,
  sandboxOutputRootHostPath,
  sandboxOutputRootSandboxPath,
} from "../src/sandbox/output-root.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import {
  ingestSandboxFileTool,
  ingestSandboxFileToolDescriptor,
  type IngestSandboxFileToolOutput,
  type IngestSandboxFileToolSuccessOutput,
} from "../src/tools/ingest-sandbox-file.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import { forgetWorkspaceTaintForTesting } from "../src/workspace-taint.ts";

const FINANCE_LABEL: IFCLabel = { confidentiality: ["finance"] };

const TOTAL_TEXT = "132.0\n";

/**
 * A sandbox CFC result shaped as `cfcResultFromRunscSidecar` builds one: the
 * same label on all three observations, and streams withheld from the model
 * exactly when the container is tainted.
 */
const sandboxResult = (label: IFCLabel): CfcSandboxResult => {
  const tainted = (label.confidentiality?.length ?? 0) > 0;
  return {
    version: 1,
    stdout: tainted
      ? { channel: "stdout", policy: "opaque", label, byteLength: 0 }
      : { channel: "stdout", policy: "observed", label, segments: [] },
    stderr: tainted
      ? { channel: "stderr", policy: "opaque", label, byteLength: 0 }
      : { channel: "stderr", policy: "observed", label, segments: [] },
    exitCode: tainted
      ? { policy: "opaque", label }
      : { policy: "observed", label, value: 0 },
  };
};

/**
 * Stands in for the gVisor sandbox. `cfcResult` is what runsc reported for
 * the container, which the harness reads out of a sidecar the sandboxed
 * workload cannot write; `env` records what each invocation was handed.
 */
class FakeSandbox implements SandboxRuntime {
  readonly env: Record<string, string>[] = [];

  constructor(readonly cfcResult: CfcSandboxResult | undefined) {}

  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = "/workspace"): string {
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

  run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.env.push({ ...request.env });
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      ...(this.cfcResult !== undefined ? { cfcResult: this.cfcResult } : {}),
    });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return this.run({ argv: [], ...(request.env ? { env: request.env } : {}) });
  }
}

interface Fixture {
  engine: CfHarnessEngine;
  pieces: PiecesController;
  workspace: string;

  /** The output directory on the host, where the fixture plants files. */
  outputRoot: string;

  /** The same directory as a caller names it, which is what ingest takes. */
  outputDir: string;

  sandbox: FakeSandbox;
  runId: string;
}

/**
 * Runs one sandbox invocation under `taint`, then places `outputFiles` in the
 * output directory the run family just established — the arrangement a real
 * run reaches once its sandboxed work has written there.
 *
 * `taint: undefined` stands for an invocation that returned no readable CFC
 * result at all, which is what a run with no runsc transport produces.
 */
const withRun = async (
  options: {
    taint: IFCLabel | undefined;
    outputFiles?: Readonly<Record<string, string | Uint8Array>>;
    workspaceFiles?: Readonly<Record<string, string>>;
  },
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> => {
  const identity = await Identity.fromPassphrase(
    `ingest-sandbox-file-${crypto.randomUUID()}`,
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager,
  });
  const pieces = new PiecesController(
    await createSession({
      identity,
      spaceName: `ingest-sandbox-file-${crypto.randomUUID()}`,
    }),
    runtime,
  );
  await pieces.synced();
  const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
  const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
  try {
    for (
      const [name, content] of Object.entries(options.workspaceFiles ?? {})
    ) {
      await Deno.writeTextFile(join(workspace, name), content);
    }
    const sandbox = new FakeSandbox(
      options.taint === undefined ? undefined : sandboxResult(options.taint),
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: sandbox,
      runId,
      workspaceHostPath: workspace,
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
    // The invocation that earns the taint, and that establishes the family's
    // output directory before anything writes into it.
    await engine.invokeBuiltinTool("bash", { command: "sqlite3 …" });
    const outputRoot = sandboxOutputRootHostPath(workspace, runId);
    for (const [name, content] of Object.entries(options.outputFiles ?? {})) {
      const path = join(outputRoot, name);
      await (typeof content === "string"
        ? Deno.writeTextFile(path, content)
        : Deno.writeFile(path, content));
    }
    await body({
      engine,
      pieces,
      workspace,
      outputRoot,
      outputDir: sandboxOutputRootSandboxPath("/workspace", runId),
      sandbox,
      runId,
    });
  } finally {
    forgetWorkspaceTaintForTesting(runId);
    await Deno.remove(workspace, { recursive: true });
    await runtime.dispose();
    await storageManager.close();
  }
};

const cellLabel = async (
  pieces: PiecesController,
  output: IngestSandboxFileToolSuccessOutput,
  expectedText = TOTAL_TEXT,
): Promise<IFCLabel | undefined> => {
  const cell = pieces.runtime.getCellFromLink(
    parseLLMFriendlyLink(output.cellRef, pieces.getSpace()),
  );
  await cell.sync();
  expect(cell.getRaw()).toBe(expectedText);
  return cfcLabelViewForCell(cell)?.entries.find((entry) =>
    entry.path.length === 0
  )?.label;
};

const succeeded = (
  output: IngestSandboxFileToolOutput,
): IngestSandboxFileToolSuccessOutput => {
  expect(output.status).toBe("ok");
  return output as IngestSandboxFileToolSuccessOutput;
};

const failure = (
  output: IngestSandboxFileToolOutput,
): { message: string } => {
  expect(output.status).toBe("error");
  return output as { message: string };
};

const ingest = (
  engine: CfHarnessEngine,
  path: string,
): Promise<IngestSandboxFileToolOutput> =>
  engine.invokeBuiltinTool("ingest_sandbox_file", { path }).then((result) =>
    result.output
  );

/** A tool context holding only what one refusal turns on. */
const unitContext = (
  overrides: Partial<HarnessToolContext>,
): HarnessToolContext =>
  ({
    runId: "ingest-sandbox-file-unit",
    workspaceTaint: { kind: "known" },
    sandboxOutputRootSandboxPath: "/workspace/.cf-harness/out/unit",
    sandboxOutputRootHostPath: "/host/out/unit",
    nextOutputId: () =>
      createToolOutputId("ingest-sandbox-file-unit", "ingest_sandbox_file", 1),
    resolvePath: (path: string) => path,
    resolveHostPath: (path: string) => path,
    ...overrides,
  }) as unknown as HarnessToolContext;

/** A session whose commit answers however the case under test needs it to. */
const fakeSession = (
  commit: () => Promise<{ error?: Error }>,
): HarnessFabricSession =>
  ({
    pieces: {
      getSpace: () => "did:key:test",
      runtime: {
        getCell: () => ({
          getAsNormalizedFullLink: () => ({
            id: "of:test",
            space: "did:key:test",
            path: [],
            type: "application/json",
          }),
          withTx: () => ({ set: () => {} }),
        }),
        editWithRetry: commit,
        idle: () => Promise.resolve(),
      },
    },
  }) as unknown as HarnessFabricSession;

describe("ingest_sandbox_file", () => {
  it("writes a cell carrying the confidentiality of the family's sandbox work", async () => {
    await withRun(
      { taint: FINANCE_LABEL, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, pieces, outputDir }) => {
        const output = succeeded(
          await ingest(engine, `${outputDir}/total.txt`),
        );

        expect(output.labeled).toBe(true);
        expect(output.bytes).toBe(6);
        expect(await cellLabel(pieces, output)).toEqual(FINANCE_LABEL);
      },
    );
  });

  it("writes an unlabeled cell for a family whose sandbox reported no taint", async () => {
    await withRun(
      { taint: {}, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, pieces, outputDir }) => {
        const output = succeeded(
          await ingest(engine, `${outputDir}/total.txt`),
        );

        expect(output.labeled).toBe(false);
        expect(await cellLabel(pieces, output)).toBeUndefined();
      },
    );
  });

  it("refuses a file in the workspace but outside the run's output directory", async () => {
    // Containment is not provenance. The workspace is a directory the
    // operator names, so a file sitting in it may predate the run entirely;
    // only the directory the harness made fresh says otherwise.

    await withRun(
      { taint: FINANCE_LABEL, workspaceFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine }) => {
        const output = failure(
          await ingest(engine, "/workspace/total.txt"),
        );

        expect(output.message).toContain("only reads files under this run's");
        expect(output.message).toContain(SANDBOX_OUTPUT_DIR_ENV);
      },
    );
  });

  it("refuses everything once a sandbox invocation left no evidence", async () => {
    // The invocation could have written anything under any label, so the
    // family's knowledge is not clean — it is gone, and no later invocation
    // brings it back.

    await withRun(
      { taint: undefined, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, outputDir }) => {
        const output = failure(
          await ingest(engine, `${outputDir}/total.txt`),
        );

        expect(output.message).toContain("cannot label anything from this run");
        expect(engine.workspaceTaint.kind).toBe("unknown");
      },
    );
  });

  it("stays refusing after a later invocation reports a clean container", async () => {
    await withRun(
      { taint: undefined, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, outputDir, workspace, runId }) => {
        // A second engine over the same family, whose sandbox does report a
        // result: the hole the first one left is not filled by it.
        const clean = new CfHarnessEngine({
          sandboxRuntime: new FakeSandbox(sandboxResult({})),
          runId: `${runId}.later`,
          lineage: {
            role: "subagent",
            rootRunId: runId,
            parentRunId: runId,
            parentToolCallId: "call-1",
            depth: 1,
          },
          workspaceHostPath: workspace,
        });
        await clean.invokeBuiltinTool("bash", { command: "echo hi" });

        expect(clean.workspaceTaint.kind).toBe("unknown");
        expect(
          failure(await ingest(engine, `${outputDir}/total.txt`)).message,
        ).toContain("cannot label anything from this run");
      },
    );
  });

  it("labels a parent's ingest with the taint a delegated child earned", async () => {
    // The child shares the workspace, the sandbox and the output directory,
    // so its taint has to reach the parent's ingest; a per-engine
    // accumulator would let a clean parent mint an unlabeled cell over bytes
    // its child wrote under a label.

    await withRun(
      { taint: {}, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, pieces, outputDir, workspace, runId }) => {
        const child = new CfHarnessEngine({
          sandboxRuntime: new FakeSandbox(sandboxResult(FINANCE_LABEL)),
          runId: `${runId}.subagent.1`,
          lineage: {
            role: "subagent",
            rootRunId: runId,
            parentRunId: runId,
            parentToolCallId: "call-1",
            depth: 1,
          },
          workspaceHostPath: workspace,
        });
        await child.invokeBuiltinTool("bash", { command: "sqlite3 …" });

        const output = succeeded(
          await ingest(engine, `${outputDir}/total.txt`),
        );

        expect(output.labeled).toBe(true);
        expect(await cellLabel(pieces, output)).toEqual(FINANCE_LABEL);
      },
    );
  });

  it("refuses a file that is not valid UTF-8 rather than altering its bytes", async () => {
    await withRun(
      {
        taint: FINANCE_LABEL,
        outputFiles: { "raw.bin": new Uint8Array([0xff, 0x00]) },
      },
      async ({ engine, outputDir }) => {
        const output = failure(
          await ingest(engine, `${outputDir}/raw.bin`),
        );

        expect(output.message).toContain("not valid UTF-8");
      },
    );
  });

  it("reports the file's own byte length rather than its decoded size", async () => {
    // Two bytes on disk, one code point; a lenient decode would have made
    // this three.

    await withRun(
      { taint: {}, outputFiles: { "total.txt": "é" } },
      async ({ engine, pieces, outputDir }) => {
        const output = succeeded(
          await ingest(engine, `${outputDir}/total.txt`),
        );

        expect(output.bytes).toBe(2);
        expect(await cellLabel(pieces, output, "é")).toBeUndefined();
      },
    );
  });

  it("hands every sandbox invocation the output directory", async () => {
    await withRun({ taint: {} }, ({ sandbox, runId }) => {
      expect(sandbox.env.length).toBeGreaterThan(0);
      for (const env of sandbox.env) {
        expect(env[SANDBOX_OUTPUT_DIR_ENV]).toBe(
          `/workspace/.cf-harness/out/${runId}`,
        );
      }
      return Promise.resolve();
    });
  });

  it("ingests nothing from an output directory it did not create", async () => {
    // A directory already standing where this family's would go holds files
    // nothing here can account for, which is the one thing the label rests
    // on. The run goes on; what it loses is the ability to ingest.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    try {
      const outputRoot = sandboxOutputRootHostPath(workspace, runId);
      await Deno.mkdir(outputRoot, { recursive: true });
      await Deno.writeTextFile(join(outputRoot, "planted.txt"), "not ours");
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult({})),
        runId,
        workspaceHostPath: workspace,
        fabricSessionFactory: () =>
          Promise.reject(new Error("no session should be opened")),
      });

      const planted = await engine.invokeBuiltinTool("ingest_sandbox_file", {
        path: `${
          sandboxOutputRootSandboxPath("/workspace", runId)
        }/planted.txt`,
      });

      expect(engine.sandboxOutputRootFailure).toMatch(
        /output directory already exists/,
      );
      expect(failure(planted.output as IngestSandboxFileToolOutput).message)
        .toContain("has no output directory of this run's own");
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("keeps running a tool when the workspace cannot hold an output directory", async () => {
    // The directory serves ingest and nothing else, so a workspace that
    // cannot hold one costs the run its ingest rather than its tools.

    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    try {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult({})),
        runId,
        workspaceHostPath: "/dev/null/not-a-directory",
      });

      const result = await engine.invokeBuiltinTool("bash", {
        command: "echo hi",
      });

      expect((result.output as { exitCode: number }).exitCode).toBe(0);
      expect(engine.sandboxOutputRootFailure).toBeDefined();
    } finally {
      forgetWorkspaceTaintForTesting(runId);
    }
  });

  it("ignores a label passed as a tool input", async () => {
    await withRun(
      { taint: FINANCE_LABEL, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, pieces, outputDir }) => {
        const result = await engine.invokeBuiltinTool(
          "ingest_sandbox_file",
          {
            path: `${outputDir}/total.txt`,
            label: { confidentiality: [] },
          } as unknown as { path: string },
        );

        expect(await cellLabel(pieces, succeeded(result.output)))
          .toEqual(FINANCE_LABEL);
      },
    );
  });

  it("ignores a label the sandboxed workload wrote beside its output", async () => {
    await withRun(
      {
        taint: FINANCE_LABEL,
        outputFiles: {
          "total.txt": TOTAL_TEXT,
          "total.txt.cfc.json": '{"confidentiality":[]}',
        },
      },
      async ({ engine, pieces, outputDir }) => {
        const output = succeeded(
          await ingest(engine, `${outputDir}/total.txt`),
        );

        expect(await cellLabel(pieces, output)).toEqual(FINANCE_LABEL);
      },
    );
  });

  it("keeps a successful write_file's sandbox result on its output", async () => {
    // The taint is collected at the invocation boundary, so a tool cannot
    // lose it — but the run's own record is read from the tool output, and a
    // write that reported nothing there would leave a reader unable to see
    // what the write was exposed to.

    await withRun({ taint: FINANCE_LABEL }, async ({ engine, outputDir }) => {
      const result = await engine.invokeBuiltinTool("write_file", {
        path: `${outputDir}/written.txt`,
        content: TOTAL_TEXT,
      });

      expect((result.output as { cfcResult?: CfcSandboxResult }).cfcResult)
        .toEqual(sandboxResult(FINANCE_LABEL));
    });
  });

  it("declares an input schema with no property a label could arrive in", () => {
    expect(ingestSandboxFileToolDescriptor.inputSchema).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            `Path to the file, under the run's output directory ($${SANDBOX_OUTPUT_DIR_ENV}); absolute or relative to the current directory.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("refuses a run with no fabric session", async () => {
    const output = await ingestSandboxFileTool.invoke(
      unitContext({}),
      { path: "/workspace/.cf-harness/out/unit/total.txt" },
    );

    expect(failure(output).message).toContain("requires a fabric session");
  });

  it("refuses a path that is blank", async () => {
    const output = await ingestSandboxFileTool.invoke(
      unitContext({
        getFabricSession: () =>
          Promise.reject(new Error("no session should be opened")),
      }),
      { path: "   " },
    );

    expect(failure(output).message).toBe(
      "ingest_sandbox_file requires a path",
    );
  });

  it("refuses a run with no workspace to hold an output directory", async () => {
    const output = await ingestSandboxFileTool.invoke(
      unitContext({
        getFabricSession: () =>
          Promise.reject(new Error("no session should be opened")),
        sandboxOutputRootHostPath: undefined,
      }),
      { path: "/workspace/total.txt" },
    );

    expect(failure(output).message).toContain(
      "has no output directory of this run's own",
    );
  });

  it("reports a file it could not read", async () => {
    await withRun(
      { taint: FINANCE_LABEL },
      async ({ engine, outputDir }) => {
        const output = failure(
          await ingest(engine, `${outputDir}/absent.txt`),
        );

        expect(output.message).toMatch(
          /^ingest_sandbox_file could not read the file: /,
        );
      },
    );
  });

  it("reports a refused commit as an error rather than a reference", async () => {
    // The commit boundary is where a labeled write is rejected, so this is
    // the shape a run under enforcement meets. Nothing is returned to pass
    // on, because nothing landed.

    const file = await Deno.makeTempFile();
    try {
      await Deno.writeTextFile(file, TOTAL_TEXT);
      const output = await ingestSandboxFileTool.invoke(
        unitContext({
          getFabricSession: () =>
            Promise.resolve(
              fakeSession(() =>
                Promise.resolve({ error: new Error("commit refused") })
              ),
            ),
          sandboxOutputRootHostPath: "/",
          resolveHostPath: () => file,
        }),
        { path: file },
      );

      expect(failure(output).message).toBe(
        "ingest_sandbox_file could not write the cell: commit refused",
      );
    } finally {
      await Deno.remove(file);
    }
  });

  it("reports a session that could not be established", async () => {
    const file = await Deno.makeTempFile();
    try {
      await Deno.writeTextFile(file, TOTAL_TEXT);
      const output = await ingestSandboxFileTool.invoke(
        unitContext({
          getFabricSession: () =>
            Promise.reject(new Error("no space reachable")),
          sandboxOutputRootHostPath: "/",
          resolveHostPath: () => file,
        }),
        { path: file },
      );

      expect(failure(output).message).toBe(
        "ingest_sandbox_file failed: no space reachable",
      );
    } finally {
      await Deno.remove(file);
    }
  });

  it("reports a path it could not resolve", async () => {
    await withRun({ taint: {} }, async ({ engine }) => {
      const output = failure(await ingest(engine, "/etc/hosts"));

      expect(output.message).toMatch(
        /^ingest_sandbox_file could not resolve the path: /,
      );
    });
  });
});
