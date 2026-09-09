/**
 * The sandbox round trip's return half: what label a cell minted from sandbox
 * output carries, and which sources that label may and may not come from.
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

import { CfHarnessEngine } from "../src/engine.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  ingestSandboxFileTool,
  ingestSandboxFileToolDescriptor,
  type IngestSandboxFileToolOutput,
  type IngestSandboxFileToolSuccessOutput,
} from "../src/tools/ingest-sandbox-file.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";

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
 * workload cannot write; the rest is what the workload itself produced.
 */
class TaintingSandboxRuntime implements SandboxRuntime {
  constructor(readonly cfcResult: CfcSandboxResult) {}

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

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      cfcResult: this.cfcResult,
    });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return this.run({ argv: [] });
  }
}

interface Fixture {
  engine: CfHarnessEngine;
  pieces: PiecesController;
  workspace: string;
}

/**
 * Runs one labeled or unlabeled sandbox invocation, having placed
 * `workspaceFiles` where the workspace mount makes them visible on the host —
 * the arrangement a real run reaches after the sandboxed work writes into
 * `/workspace`.
 */
const withRun = async (
  options: {
    taint: IFCLabel;
    workspaceFiles: Readonly<Record<string, string>>;
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
  try {
    for (const [name, content] of Object.entries(options.workspaceFiles)) {
      await Deno.writeTextFile(join(workspace, name), content);
    }
    const engine = new CfHarnessEngine({
      sandboxRuntime: new TaintingSandboxRuntime(sandboxResult(options.taint)),
      runId: `ingest-sandbox-file-${crypto.randomUUID()}`,
      workspaceHostPath: workspace,
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
    // The invocation that earns the taint. Its streams are withheld when the
    // container is tainted, which is the case the round trip exists for.
    await engine.invokeBuiltinTool("bash", { command: "sqlite3 …" });
    await body({ engine, pieces, workspace });
  } finally {
    await Deno.remove(workspace, { recursive: true });
    await runtime.dispose();
    await storageManager.close();
  }
};

const cellLabel = async (
  pieces: PiecesController,
  output: IngestSandboxFileToolSuccessOutput,
): Promise<IFCLabel | undefined> => {
  const cell = pieces.runtime.getCellFromLink(
    parseLLMFriendlyLink(output.cellRef, pieces.getSpace()),
  );
  await cell.sync();
  expect(cell.getRaw()).toBe(TOTAL_TEXT);
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

describe("ingest_sandbox_file", () => {
  it("writes a cell carrying the confidentiality of the run's sandbox invocation", async () => {
    await withRun(
      { taint: FINANCE_LABEL, workspaceFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, pieces }) => {
        const result = await engine.invokeBuiltinTool("ingest_sandbox_file", {
          path: "/workspace/total.txt",
        });
        const output = succeeded(result.output);

        expect(output.labeled).toBe(true);
        expect(output.bytes).toBe(6);
        expect(await cellLabel(pieces, output)).toEqual(FINANCE_LABEL);
      },
    );
  });

  it("writes an unlabeled cell for a run whose sandbox reported no taint", async () => {
    await withRun(
      { taint: {}, workspaceFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, pieces }) => {
        const result = await engine.invokeBuiltinTool("ingest_sandbox_file", {
          path: "/workspace/total.txt",
        });
        const output = succeeded(result.output);

        expect(output.labeled).toBe(false);
        expect(await cellLabel(pieces, output)).toBeUndefined();
      },
    );
  });

  it("ignores a label the sandboxed workload wrote beside its output", async () => {
    // Everything inside the container is workload-writable, so a manifest
    // claiming a label is a claim by the party the label constrains. The one
    // this run's cell takes comes from the sidecar runsc wrote instead.

    await withRun(
      {
        taint: FINANCE_LABEL,
        workspaceFiles: {
          "total.txt": TOTAL_TEXT,
          "total.txt.cfc.json": '{"confidentiality":[]}',
        },
      },
      async ({ engine, pieces }) => {
        const result = await engine.invokeBuiltinTool("ingest_sandbox_file", {
          path: "/workspace/total.txt",
        });

        expect(await cellLabel(pieces, succeeded(result.output)))
          .toEqual(FINANCE_LABEL);
      },
    );
  });

  it("ignores a label passed as a tool input", async () => {
    await withRun(
      { taint: FINANCE_LABEL, workspaceFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine, pieces }) => {
        const result = await engine.invokeBuiltinTool(
          "ingest_sandbox_file",
          {
            path: "/workspace/total.txt",
            label: { confidentiality: [] },
          } as unknown as { path: string },
        );

        expect(await cellLabel(pieces, succeeded(result.output)))
          .toEqual(FINANCE_LABEL);
      },
    );
  });

  it("declares an input schema with no property a label could arrive in", () => {
    // The cast above reaches the tool only because a test may call the engine
    // directly. What a model may write is this schema, and a label has no
    // property to arrive in and no room beside the ones it has.

    expect(ingestSandboxFileToolDescriptor.inputSchema).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file inside the sandbox workspace, absolute or relative to the current directory.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("refuses a host path an additional mount put outside the workspace", async () => {
    // A mount other than the workspace resolves to a host path that exists,
    // so the resolution succeeds and this guard is what stops it. Driven at
    // the tool rather than through the engine, whose mounts come from a
    // sandbox configuration a test cannot build without Docker.

    const output = await ingestSandboxFileTool.invoke(
      {
        runId: "ingest-sandbox-file-unit",
        nextOutputId: () =>
          createToolOutputId(
            "ingest-sandbox-file-unit",
            "ingest_sandbox_file",
            1,
          ),
        getFabricSession: () =>
          Promise.reject(new Error("no session should be opened")),
        resolvePath: (path: string) => path,
        resolveHostPath: (path: string) => path,
        isHostPathWithinWorkspace: () => Promise.resolve(false),
      } as unknown as HarnessToolContext,
      { path: "/host-bind/notes.txt" },
    );

    expect(output).toEqual({
      outputId: (output as { outputId: string }).outputId,
      status: "error",
      message: "ingest_sandbox_file only reads files in the sandbox workspace",
    });
  });

  it("refuses a path outside every host-backed sandbox root", async () => {
    await withRun(
      { taint: FINANCE_LABEL, workspaceFiles: { "total.txt": TOTAL_TEXT } },
      async ({ engine }) => {
        const result = await engine.invokeBuiltinTool("ingest_sandbox_file", {
          path: "/etc/hosts",
        });

        expect(result.output).toEqual({
          outputId: (result.output as { outputId: string }).outputId,
          status: "error",
          message:
            "ingest_sandbox_file could not resolve the path: path escapes host-backed sandbox roots: /etc/hosts",
        });
      },
    );
  });
});
