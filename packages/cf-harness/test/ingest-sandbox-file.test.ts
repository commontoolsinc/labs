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
import { dirname, join } from "@std/path";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  SANDBOX_OUTPUT_DIR_ENV,
  SANDBOX_OUTPUT_MOUNT_PATH,
  sandboxOutputRootHostPath,
} from "../src/sandbox/output-root.ts";
import type {
  CfcSandboxResultOrigin,
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

/** The shape the runtime composes when it cannot read runsc's sidecar. */
const deniedSandboxResult = (code: string): CfcSandboxResult => ({
  version: 1,
  stdout: { channel: "stdout", policy: "denied", label: {}, reason: code },
  stderr: { channel: "stderr", policy: "denied", label: {}, reason: code },
  exitCode: { policy: "denied", label: {}, reason: code },
  diagnostics: [{ level: "error", code, message: code }],
});

/**
 * Stands in for the gVisor sandbox. `cfcResult` is what runsc reported for
 * the container, which the harness reads out of a sidecar the sandboxed
 * workload cannot write; `env` records what each invocation was handed.
 *
 * `origin` is the discriminator the real runtime sets. `runsc-taint` is a
 * report; `synthetic` is what the runtime composes when it cannot read the
 * sidecar, and its empty label must never be read as a public container.
 */
class FakeSandbox implements SandboxRuntime {
  readonly env: Record<string, string>[] = [];

  constructor(
    readonly cfcResult: CfcSandboxResult | undefined,
    readonly origin: CfcSandboxResultOrigin = "runsc-taint",
  ) {}

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
    return this.isPathWithinWorkspace(path) ||
      path === SANDBOX_OUTPUT_MOUNT_PATH ||
      path.startsWith(`${SANDBOX_OUTPUT_MOUNT_PATH}/`);
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
      ...(this.cfcResult !== undefined
        ? { cfcResult: this.cfcResult, cfcResultOrigin: this.origin }
        : {}),
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
  artifactRoot: string;

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
  const artifactRoot = await Deno.makeTempDir({
    prefix: "cf-harness-ingest-art-",
  });
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
      artifactRoot,
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
    // The invocation that earns the taint, and that establishes the family's
    // output directory before anything writes into it.
    await engine.invokeBuiltinTool("bash", { command: "sqlite3 …" });
    const outputRoot = sandboxOutputRootHostPath(artifactRoot, runId);
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
      artifactRoot,
      outputRoot,
      outputDir: SANDBOX_OUTPUT_MOUNT_PATH,
      sandbox,
      runId,
    });
  } finally {
    forgetWorkspaceTaintForTesting(runId);
    await Deno.remove(workspace, { recursive: true });
    await Deno.remove(artifactRoot, { recursive: true });
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
    sandboxOutputMountPath: SANDBOX_OUTPUT_MOUNT_PATH,
    sandboxOutputRoot: { hostPath: "/host/out/unit", dev: 1, ino: 1 },
    nextOutputId: () =>
      createToolOutputId("ingest-sandbox-file-unit", "ingest_sandbox_file", 1),
    resolvePath: (path: string) => path,
    resolveHostPath: (path: string) => path,
    ...overrides,
  }) as unknown as HarnessToolContext;

/** The recorded identity of an existing directory, for a unit context. */
const rootOf = async (hostPath: string) => {
  const stat = await Deno.stat(hostPath);
  return { hostPath, dev: stat.dev!, ino: stat.ino! };
};

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
    await withRun({ taint: {} }, ({ sandbox }) => {
      expect(sandbox.env.length).toBeGreaterThan(0);
      for (const env of sandbox.env) {
        expect(env[SANDBOX_OUTPUT_DIR_ENV]).toBe(SANDBOX_OUTPUT_MOUNT_PATH);
      }
      return Promise.resolve();
    });
  });

  it("ingests nothing from an output directory it did not create", async () => {
    // A directory already standing where this family's would go holds files
    // nothing here can account for, which is the one thing the label rests
    // on. The run goes on; what it loses is the ability to ingest.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    try {
      const outputRoot = sandboxOutputRootHostPath(artifactRoot, runId);
      await Deno.mkdir(outputRoot, { recursive: true });
      await Deno.writeTextFile(join(outputRoot, "planted.txt"), "not ours");
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult({})),
        runId,
        workspaceHostPath: workspace,
        artifactRoot,
        fabricSessionFactory: () =>
          Promise.reject(new Error("no session should be opened")),
      });

      const planted = await engine.invokeBuiltinTool("ingest_sandbox_file", {
        path: `${SANDBOX_OUTPUT_MOUNT_PATH}/planted.txt`,
      });

      expect(engine.sandboxOutputRootFailure).toMatch(
        /output directory already exists/,
      );
      expect(failure(planted.output as IngestSandboxFileToolOutput).message)
        .toContain("has no output directory of this run's own");
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
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

  it("poisons the family when a sandbox invocation throws", async () => {
    // A container that failed to start, or timed out, still ran — and left
    // no result to read. Observing only invocations that returned would let a
    // family lose one by having it fail.

    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    try {
      const throwing = new FakeSandbox(sandboxResult(FINANCE_LABEL));
      throwing.run = () => Promise.reject(new Error("docker unreachable"));
      const engine = new CfHarnessEngine({
        sandboxRuntime: throwing,
        runId,
        workspaceHostPath: workspace,
      });

      await expect(engine.invokeBuiltinTool("bash", { command: "x" }))
        .rejects.toThrow(/docker unreachable/);
      expect(engine.workspaceTaint.kind).toBe("unknown");
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("answers path questions as the runtime it wraps does", async () => {
    // The instrumented view is the sandbox tools resolve paths through, so a
    // question it answered differently would move where a tool may write.

    await withRun({ taint: {} }, ({ engine }) => {
      expect(engine.sandbox.isPathWithinWorkspace("/workspace/x")).toBe(true);
      expect(engine.sandbox.isPathWithinWorkspace("/etc/passwd")).toBe(false);
      expect(engine.sandbox.isPathWithinAllowedRoots("/workspace/x")).toBe(
        true,
      );
      expect(engine.sandbox.defaultWorkingDirectory()).toBe("/workspace");
      expect(engine.sandbox.describe().kind).toBe("docker-runsc-cfc");
      return Promise.resolve();
    });
  });

  it("reports a directory it could not create for a reason other than reuse", async () => {
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    try {
      // The parent exists and admits no children, so the leaf fails for a
      // reason that is not "one is already there".
      await Deno.mkdir(join(artifactRoot, runId), { recursive: true });
      await Deno.chmod(join(artifactRoot, runId), 0o500);
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult({})),
        runId,
        workspaceHostPath: workspace,
        artifactRoot,
      });

      await engine.ensureSandboxOutputRoot();

      expect(engine.sandboxOutputRootFailure).toMatch(/[Pp]ermission denied/);
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.chmod(join(artifactRoot, "sandbox-out"), 0o700).catch(
        () => {},
      );
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("refuses a symlink in the output directory that leads outside it", async () => {
    // The sandbox can write into the output directory, so it can plant a link
    // there. A lexical containment test passes it and the read follows it, and
    // the cell would then hold bytes from a file no invocation of this run
    // wrote.

    await withRun(
      { taint: FINANCE_LABEL, workspaceFiles: { "outside.txt": "not ours" } },
      async ({ engine, outputRoot, outputDir, workspace }) => {
        await Deno.symlink(
          join(workspace, "outside.txt"),
          join(outputRoot, "link.txt"),
        );

        const output = failure(await ingest(engine, `${outputDir}/link.txt`));

        expect(output.message).toContain("only reads files under this run's");
      },
    );
  });

  it("refuses a file in the output directory that has another name elsewhere", async () => {
    // A hard link is a second directory entry for bytes this family never
    // wrote: the sandbox can make one without reading them, so the taint need
    // not cover what they require. Real-path containment cannot tell the two
    // entries apart, and the link count is what does. Between the run's own
    // filesystems such a link fails outright — the output directory is its
    // own mount — so this pins the refusal for the case where it did not.

    await withRun(
      { taint: FINANCE_LABEL },
      async ({ engine, outputRoot, outputDir, artifactRoot }) => {
        await Deno.writeTextFile(join(artifactRoot, "outside.txt"), "not ours");
        await Deno.link(
          join(artifactRoot, "outside.txt"),
          join(outputRoot, "hard.txt"),
        );

        const output = failure(await ingest(engine, `${outputDir}/hard.txt`));

        expect(output.message).toContain("more than one name");
      },
    );
  });

  it("poisons the family when a sandbox result was synthesized rather than reported", async () => {
    // The runtime composes a denied result with an EMPTY label when it cannot
    // read the sidecar — an unsupported version, a container mismatch, a
    // missing taint, a read or parse failure. Shaped exactly like a public
    // container, so only its origin tells them apart.

    for (
      const synthetic of [
        deniedSandboxResult("runsc_cfc_sidecar_version"),
        deniedSandboxResult("runsc_cfc_sidecar_container_mismatch"),
        deniedSandboxResult("runsc_cfc_sidecar_missing_taint"),
        deniedSandboxResult("runsc_cfc_sidecar_read_error"),
        deniedSandboxResult("runsc_cfc_sidecar_parse_error"),
        deniedSandboxResult("runsc_cfc_sidecar_unreadable_taint"),
      ]
    ) {
      const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
      const workspace = await Deno.makeTempDir({
        prefix: "cf-harness-ingest-",
      });
      try {
        const engine = new CfHarnessEngine({
          sandboxRuntime: new FakeSandbox(synthetic, "synthetic"),
          runId,
          workspaceHostPath: workspace,
          fabricSessionFactory: () =>
            Promise.reject(new Error("no session should be opened")),
        });
        await engine.invokeBuiltinTool("bash", { command: "x" });

        expect(engine.workspaceTaint.kind).toBe("unknown");
        const output = await engine.invokeBuiltinTool("ingest_sandbox_file", {
          path: `${SANDBOX_OUTPUT_MOUNT_PATH}/x.txt`,
        });
        expect(
          failure(output.output as IngestSandboxFileToolOutput).message,
        ).toContain("cannot label anything from this run");
      } finally {
        forgetWorkspaceTaintForTesting(runId);
        await Deno.remove(workspace, { recursive: true });
      }
    }
  });

  it("poisons the family when a result claims runsc origin but is malformed", async () => {
    // The origin says the sidecar was read; the result says otherwise. A
    // reader that trusted the origin alone would take a shape it cannot
    // interpret as a container with nothing on it.

    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    try {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(
          {
            ...sandboxResult(FINANCE_LABEL),
            version: 2,
          } as unknown as CfcSandboxResult,
          "runsc-taint",
        ),
        runId,
        workspaceHostPath: workspace,
      });

      await engine.invokeBuiltinTool("bash", { command: "x" });

      expect(engine.workspaceTaint.kind).toBe("unknown");
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("poisons the family when a sandbox invocation throws synchronously", async () => {
    // A runtime is free to throw before it returns a promise, and that shape
    // of failure reaches no `catch` that awaits the call.

    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    try {
      const throwing = new FakeSandbox(sandboxResult(FINANCE_LABEL));
      throwing.runShell = () => {
        throw new Error("docker missing");
      };
      throwing.run = () => {
        throw new Error("docker missing");
      };
      const engine = new CfHarnessEngine({
        sandboxRuntime: throwing,
        runId,
        workspaceHostPath: workspace,
      });

      await expect(engine.invokeBuiltinTool("bash", { command: "x" }))
        .rejects.toThrow(/docker missing/);
      expect(engine.workspaceTaint.kind).toBe("unknown");
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("keeps a resumed run's unknown taint unknown", async () => {
    // The in-process map is empty when a resumed run starts, and an empty
    // entry reads as clean. A run that ended unable to say what it saw must
    // not come back able to mint.

    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    try {
      const first = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(undefined),
        runId,
        workspaceHostPath: workspace,
      });
      await first.invokeBuiltinTool("bash", { command: "x" });
      const persisted = first.getRunState();
      expect(persisted.cfcWorkspaceTaint?.kind).toBe("unknown");
      forgetWorkspaceTaintForTesting(runId);

      const resumed = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult({})),
        runState: persisted,
        workspaceHostPath: workspace,
      });
      await resumed.invokeBuiltinTool("bash", { command: "echo clean" });

      expect(resumed.workspaceTaint.kind).toBe("unknown");
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("keeps a resumed run's label, and treats a record that states none as unknown", async () => {
    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    try {
      const first = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult(FINANCE_LABEL)),
        runId,
        workspaceHostPath: workspace,
      });
      await first.invokeBuiltinTool("bash", { command: "x" });
      const persisted = first.getRunState();
      forgetWorkspaceTaintForTesting(runId);

      const resumed = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult({})),
        runState: persisted,
        workspaceHostPath: workspace,
      });

      expect(resumed.workspaceTaint).toEqual({
        kind: "known",
        label: FINANCE_LABEL,
      });

      // A record written before this field existed says nothing about what
      // its invocations saw, which is the same absence a lost sidecar leaves.
      forgetWorkspaceTaintForTesting(runId);
      const { cfcWorkspaceTaint: _dropped, ...silent } = persisted;
      const fromSilentRecord = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult({})),
        runState: silent,
        workspaceHostPath: workspace,
      });

      expect(fromSilentRecord.workspaceTaint.kind).toBe("unknown");
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("stores a byte-order mark as bytes rather than dropping it", async () => {
    // `TextDecoder` strips a leading U+FEFF by default, which would take three
    // bytes out of the value while `bytes` still reported the file's length.

    await withRun(
      {
        taint: {},
        outputFiles: {
          "bom.txt": new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
        },
      },
      async ({ engine, pieces, outputDir }) => {
        const output = succeeded(await ingest(engine, `${outputDir}/bom.txt`));

        expect(output.bytes).toBe(4);
        expect(await cellLabel(pieces, output, "\uFEFFa")).toBeUndefined();
      },
    );
  });

  it("reports a path that resolves but cannot be read", async () => {
    // Resolution and the read are two syscalls, so the file can stop being a
    // readable file between them. A directory under the output directory
    // resolves and refuses to be read, which is the same shape.

    await withRun({ taint: {} }, async ({ engine, outputRoot, outputDir }) => {
      await Deno.mkdir(join(outputRoot, "subdir"));

      const output = failure(await ingest(engine, `${outputDir}/subdir`));

      expect(output.message).toMatch(
        /^ingest_sandbox_file could not read the file: /,
      );
    });
  });

  it("refuses to read from a root that was replaced after it was created", async () => {
    // A directory's name can be re-pointed. The output directory is its own
    // mount, so a workload cannot do it from inside — but the label rests on
    // this being the directory the family made, and that is checked rather
    // than assumed.

    await withRun(
      { taint: FINANCE_LABEL, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, outputRoot, outputDir, artifactRoot }) => {
        const decoy = join(artifactRoot, "decoy");
        await Deno.mkdir(decoy);
        await Deno.writeTextFile(join(decoy, "total.txt"), "not ours");
        await Deno.remove(outputRoot, { recursive: true });
        await Deno.symlink(decoy, outputRoot);

        const output = failure(await ingest(engine, `${outputDir}/total.txt`));

        expect(output.message).toContain(
          "found something other than the directory this run created",
        );
      },
    );
  });

  it("carries a delegated child's taint into the parent's own record", async () => {
    // The parent's record is what a later resume reads. A child that updated
    // only its own would leave the parent saying the family was clean, and
    // the next process would believe it.

    await withRun(
      { taint: {}, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, workspace, artifactRoot, runId }) => {
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
          artifactRoot,
        });
        await child.invokeBuiltinTool("bash", { command: "sqlite3 …" });

        expect(engine.getRunState().cfcWorkspaceTaint).toEqual({
          kind: "known",
          label: FINANCE_LABEL,
        });
      },
    );
  });

  it("ingests from the output directory a resumed run recorded", async () => {
    // A resumed run must not try to create the directory its own earlier
    // process made: refusing it as somebody else's would disable ingest for
    // the rest of the run.

    await withRun(
      { taint: FINANCE_LABEL, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, pieces, workspace, artifactRoot, outputDir, runId }) => {
        const persisted = engine.getRunState();
        expect(persisted.sandboxOutputRoot?.hostPath).toBeDefined();

        const resumed = new CfHarnessEngine({
          sandboxRuntime: new FakeSandbox(sandboxResult(FINANCE_LABEL)),
          runState: persisted,
          workspaceHostPath: workspace,
          artifactRoot,
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        });
        const result = await resumed.invokeBuiltinTool("ingest_sandbox_file", {
          path: `${outputDir}/total.txt`,
        });

        expect(resumed.sandboxOutputRootFailure).toBeUndefined();
        const output = succeeded(result.output as IngestSandboxFileToolOutput);
        expect(await cellLabel(pieces, output)).toEqual(FINANCE_LABEL);
        forgetWorkspaceTaintForTesting(runId);
      },
    );
  });

  it("refuses to restore an output directory that is no longer the recorded one", async () => {
    await withRun(
      { taint: {}, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, workspace, artifactRoot, outputRoot }) => {
        const persisted = engine.getRunState();
        await Deno.remove(outputRoot, { recursive: true });
        await Deno.mkdir(outputRoot, { recursive: true });

        const resumed = new CfHarnessEngine({
          sandboxRuntime: new FakeSandbox(sandboxResult({})),
          runState: persisted,
          workspaceHostPath: workspace,
          artifactRoot,
        });
        await resumed.ensureSandboxOutputRoot();

        expect(resumed.sandboxOutputRootFailure).toMatch(
          /is not the one the run this resumes created/,
        );
      },
    );
  });

  it("refuses a resume whose recorded output directory is gone", async () => {
    await withRun(
      { taint: {}, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, workspace, artifactRoot, outputRoot }) => {
        const persisted = engine.getRunState();
        await Deno.remove(outputRoot, { recursive: true });

        const resumed = new CfHarnessEngine({
          sandboxRuntime: new FakeSandbox(sandboxResult({})),
          runState: persisted,
          workspaceHostPath: workspace,
          artifactRoot,
        });
        await resumed.ensureSandboxOutputRoot();

        expect(resumed.sandboxOutputRootFailure).toMatch(/cannot be read/);
      },
    );
  });

  it("refuses a resume whose recorded output path now holds a file", async () => {
    // Removed and replaced by something that is not a directory: the path is
    // readable, so this is not the "gone" case, and it is still not a
    // directory this host can identify as the recorded one.

    await withRun(
      { taint: {}, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, workspace, artifactRoot, outputRoot }) => {
        const persisted = engine.getRunState();
        await Deno.remove(outputRoot, { recursive: true });
        await Deno.writeTextFile(outputRoot, "not a directory");

        const resumed = new CfHarnessEngine({
          sandboxRuntime: new FakeSandbox(sandboxResult({})),
          runState: persisted,
          workspaceHostPath: workspace,
          artifactRoot,
        });
        await resumed.ensureSandboxOutputRoot();

        expect(resumed.sandboxOutputRootFailure).toMatch(
          /not a directory this host can identify/,
        );
      },
    );
  });

  it("refuses an output path that is not a directory", async () => {
    // A file standing where the directory would go is not a directory this
    // host can identify as one, and the run loses its ingest rather than
    // reading out of it.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-ingest-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    const runId = `ingest-sandbox-file-${crypto.randomUUID()}`;
    try {
      await Deno.mkdir(join(artifactRoot, runId), { recursive: true });
      await Deno.writeTextFile(
        join(artifactRoot, runId, "sandbox-out"),
        "not a directory",
      );
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandbox(sandboxResult({})),
        runId,
        workspaceHostPath: workspace,
        artifactRoot,
      });

      await engine.ensureSandboxOutputRoot();

      expect(engine.sandboxOutputRootFailure).toMatch(/already exists/);
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("refuses to read once the output directory has been removed", async () => {
    await withRun(
      { taint: FINANCE_LABEL, outputFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, outputRoot, outputDir }) => {
        await Deno.remove(outputRoot, { recursive: true });

        const output = failure(await ingest(engine, `${outputDir}/total.txt`));

        expect(output.message).toContain(
          "found something other than the directory this run created",
        );
      },
    );
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
      { path: `${SANDBOX_OUTPUT_MOUNT_PATH}/total.txt` },
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
        sandboxOutputRoot: undefined,
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
          sandboxOutputRoot: await rootOf(dirname(file)),
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
          sandboxOutputRoot: await rootOf(dirname(file)),
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
