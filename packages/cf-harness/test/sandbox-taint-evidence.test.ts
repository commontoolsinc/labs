/**
 * What a run's sandbox taint is read from, and what it does with a shape it
 * cannot read.
 *
 * Every case here is a way for the read to end without an answer — by raising,
 * or by returning something the merge quietly drops. Both leave the run
 * recorded as it was, which is to say clean, and neither shows up as a
 * failure anywhere else.
 */

import type { CfcSandboxResult, IFCLabel } from "@commonfabric/runner/cfc";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { CfHarnessEngine } from "../src/engine.ts";
import type {
  CfcSandboxResultOrigin,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { forgetSandboxTaintForTesting } from "../src/sandbox-taint.ts";

const FINANCE: IFCLabel = { confidentiality: ["finance"] };

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

class FakeSandbox implements SandboxRuntime {
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
    return path.startsWith("/workspace");
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
      ...(this.cfcResult !== undefined
        ? { cfcResult: this.cfcResult, cfcResultOrigin: this.origin }
        : {}),
    });
  }
  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return this.run({ argv: [] });
  }
}

const taintAfter = async (
  cfcResult: CfcSandboxResult | undefined,
  origin: CfcSandboxResultOrigin = "runsc-taint",
) => {
  const runId = `taint-${crypto.randomUUID()}`;
  try {
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandbox(cfcResult, origin),
      runId,
      workspaceHostPath: "/tmp",
    });
    await engine.invokeBuiltinTool("bash", { command: "x" });
    return engine.sandboxTaint;
  } finally {
    forgetSandboxTaintForTesting(runId);
  }
};

/** A label whose data is where the shape check does not look by default. */
const labelWith = (
  where:
    | "root-getter"
    | "nested-getter"
    | "toJSON"
    | "proxy"
    | "deep"
    | "cycle",
): Record<string, unknown> => {
  const label: Record<string, unknown> = { confidentiality: ["finance"] };
  if (where === "root-getter") {
    // On the label's OWN property: a walk that starts below the root never
    // sees it, and it can answer differently on each read.
    let reads = 0;
    Object.defineProperty(label, "confidentiality", {
      enumerable: true,
      get() {
        reads += 1;
        return reads < 3 ? ["finance"] : [];
      },
    });
  } else if (where === "nested-getter") {
    Object.defineProperty(label.confidentiality as unknown[], "0", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
  } else if (where === "toJSON") {
    const atom = Object.create({
      toJSON() {
        throw new Error("toJSON exploded");
      },
    }) as Record<string, unknown>;
    atom.name = "finance";
    (label.confidentiality as unknown[]).push(atom);
  } else if (where === "proxy") {
    // Passes several reads, then throws — the shape a single verdict about
    // mutable input cannot catch.
    let reads = 0;
    (label.confidentiality as unknown[]).push(
      new Proxy({ name: "finance" }, {
        ownKeys(target) {
          reads += 1;
          if (reads > 3) {
            throw new Error("proxy exploded");
          }
          return Reflect.ownKeys(target);
        },
      }),
    );
  } else if (where === "deep") {
    let nest: unknown[] = ["finance"];
    for (let index = 0; index < 20_000; index++) {
      nest = [nest];
    }
    (label.confidentiality as unknown[]).push(nest);
  } else {
    const clause = label.confidentiality as unknown[];
    clause.push(clause);
  }
  return label;
};

describe("a run's sandbox taint", () => {
  it("joins the container taint a complete runsc result reported", async () => {
    expect(await taintAfter(sandboxResult(FINANCE))).toEqual({
      kind: "known",
      label: FINANCE,
    });
  });

  it("stays clean for a complete result reporting a public container", async () => {
    expect(await taintAfter(sandboxResult({}))).toEqual({ kind: "known" });
  });

  it("poisons on a result the runtime synthesized", async () => {
    const denied: CfcSandboxResult = {
      version: 1,
      stdout: { channel: "stdout", policy: "denied", label: {}, reason: "x" },
      stderr: { channel: "stderr", policy: "denied", label: {}, reason: "x" },
      exitCode: { policy: "denied", label: {}, reason: "x" },
    };

    expect((await taintAfter(denied, "synthetic")).kind).toBe("unknown");
  });

  it("poisons on an invocation that returned no result at all", async () => {
    expect((await taintAfter(undefined)).kind).toBe("unknown");
  });

  it("poisons on an incomplete or self-inconsistent result", async () => {
    const complete = sandboxResult(FINANCE);
    for (
      const malformed of [
        { ...complete, stdout: undefined },
        { ...complete, stderr: undefined },
        { ...complete, exitCode: undefined },
        { ...complete, version: 2 },
        { ...complete, stdout: { ...complete.stdout, channel: "stderr" } },
        { ...complete, stdout: { ...complete.stdout, policy: "elsewhere" } },
        {
          ...complete,
          stdout: {
            ...complete.stdout,
            policy: "observed",
            segments: undefined,
          },
        },
        {
          ...complete,
          exitCode: { ...complete.exitCode, policy: "observed", value: "1" },
        },
        // Equal labels, three policies that disagree.
        {
          ...complete,
          stdout: { ...complete.stdout, policy: "observed", segments: [] },
          stderr: { ...complete.stderr, policy: "opaque" },
          exitCode: { ...complete.exitCode, policy: "denied" },
        },
        // Three labels that disagree.
        {
          ...complete,
          stderr: { ...complete.stderr, label: { confidentiality: ["other"] } },
        },
      ]
    ) {
      expect(
        (await taintAfter(malformed as unknown as CfcSandboxResult)).kind,
      ).toBe("unknown");
    }
  });

  it("poisons rather than raising or lowering on a label it cannot read", async () => {
    for (
      const where of [
        "root-getter",
        "nested-getter",
        "toJSON",
        "proxy",
        "deep",
        "cycle",
      ] as const
    ) {
      const label = labelWith(where);
      const base = sandboxResult(FINANCE);
      const result = {
        version: 1,
        stdout: { ...base.stdout, label },
        stderr: { ...base.stderr, label },
        exitCode: { ...base.exitCode, label },
      } as unknown as CfcSandboxResult;

      expect((await taintAfter(result)).kind).toBe("unknown");
    }
  });
});
