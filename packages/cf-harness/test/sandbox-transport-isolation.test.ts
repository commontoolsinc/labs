/**
 * Where the CFC sidecar transports may live, and what a host mount path has
 * to be before it is compared against one.
 *
 * Both sidecars are trusted: the harness writes the invocation context a
 * container starts tainted from, and reads back the final taint its output
 * mediation rests on. Neither claim survives the directory being writable by
 * the workload it describes.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runCfHarnessCli } from "../src/cli.ts";
import { createFileSystemHarnessArtifactStore } from "../src/artifacts.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { resolveDockerRunscSandboxConfig } from "../src/sandbox/docker-runsc.ts";

describe("CFC sidecar transport isolation", () => {
  // The harness writes the invocation context a container starts tainted
  // from, and reads back the taint the run's evidence record is built from.
  // Neither claim survives the directory being writable by the workload it
  // describes: a container that can rewrite its own result sidecar names its
  // own taint.

  it("refuses to resolve a host path it could not read", () => {
    // The comparison is on REAL paths, so a failure to resolve one is not a
    // path that is merely absent: keeping the unresolved name would compare a
    // symlink against the mount it points into and find it outside. Only
    // "not there" may be walked past.
    const realPathSync = Deno.realPathSync;
    // Unreadable at the transport itself and at its parent, resolvable above:
    // the shape where walking past the failure ends in a path that resolved
    // without ever reading the components that decide containment.
    Deno.realPathSync = ((path: string | URL) => {
      const asString = String(path);
      if (asString.includes("/sidecars")) {
        throw new Deno.errors.PermissionDenied(`unreadable: ${asString}`);
      }
      return asString;
    }) as typeof Deno.realPathSync;
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: "/host/workspace",
          cfcResultDir: "/host/sidecars/results",
        })
      ).toThrow(Deno.errors.PermissionDenied);
    } finally {
      Deno.realPathSync = realPathSync;
    }
  });

  it("refuses a result directory inside the workspace mount", async () => {
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          cfcResultDir: join(workspace, "sidecars", "results"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("refuses an invocation-context directory inside a writable extra mount", async () => {
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    const extra = await Deno.makeTempDir({ prefix: "cf-harness-iso-mount-" });
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          additionalMounts: [{
            kind: "host-bind",
            name: "data",
            hostPath: extra,
            sandboxPath: "/data",
            readOnly: false,
          }],
          cfcInvocationContextDir: join(extra, "invocation-context"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(extra, { recursive: true });
    }
  });

  it("refuses a result directory whose parent does not exist yet", async () => {
    // These directories are created on first write, so the usual case is that
    // neither the directory nor its parent is there when the config resolves.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          cfcResultDir: join(workspace, "not", "yet", "made"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("admits a transport directory under a root that does not exist", async () => {
    // Nothing to resolve on either side, so the literal path is all there is
    // to compare — and a directory whose ancestors are absent is inside no
    // mount that exists.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    try {
      const config = resolveDockerRunscSandboxConfig({
        workspaceHostPath: workspace,
        cfcResultDir: "/cf-harness-absent-root/sidecars/results",
      });

      expect(config.cfcResultDir).toBe(
        "/cf-harness-absent-root/sidecars/results",
      );
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("refuses an empty --cfc-result-dir", async () => {
    const errors: string[] = [];
    const exitCode = await runCfHarnessCli(
      ["--prompt", "hi", "--cfc-result-dir", "  "],
      { io: { stdout: () => {}, stderr: (line: string) => errors.push(line) } },
    );

    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("requires a non-empty path");
  });

  it("refuses an invocation-context directory inside the artifact root", async () => {
    // Not a mount, but it holds the record a run writes about itself; the
    // evidence that record is labelled from does not belong there.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          artifactRootHostPath: artifactRoot,
          cfcInvocationContextDir: join(artifactRoot, "invocation-context"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("excludes the artifact root of a store the engine was handed", async () => {
    // The store that WRITES is the one whose root holds the run's record, and
    // an injected one wins over the configured root. Deriving the excluded
    // root from the config alone would leave that store's root unguarded —
    // the container writing into the directory the record it is judged by
    // lives in.
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    try {
      expect(() =>
        new CfHarnessEngine({
          runId: "run-injected-store",
          workspaceHostPath: workspace,
          artifactStore: createFileSystemHarnessArtifactStore({
            artifactRoot,
            runId: "run-injected-store",
          }),
          cfcResultDir: join(artifactRoot, "sidecars", "results"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("admits a transport directory outside every writable mount", async () => {
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    const sidecars = await Deno.makeTempDir({ prefix: "cf-harness-iso-side-" });
    try {
      const config = resolveDockerRunscSandboxConfig({
        workspaceHostPath: workspace,
        cfcResultDir: sidecars,
      });

      expect(config.cfcResultDir).toBe(sidecars);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(sidecars, { recursive: true });
    }
  });

  it("refuses a relative result directory from the environment", () => {
    // The flag is validated at the CLI, but the environment fallback reaches
    // the resolver directly — and everything below it walks the path apart,
    // which a relative path has no root to walk to.

    const previous = Deno.env.get("CF_HARNESS_RUNSC_CFC_RESULT_DIR");
    Deno.env.set("CF_HARNESS_RUNSC_CFC_RESULT_DIR", "sidecars/results");
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({ workspaceHostPath: "/host/project" })
      )
        .toThrow(/cfcResultDir must be an absolute host path/);
    } finally {
      if (previous === undefined) {
        Deno.env.delete("CF_HARNESS_RUNSC_CFC_RESULT_DIR");
      } else {
        Deno.env.set("CF_HARNESS_RUNSC_CFC_RESULT_DIR", previous);
      }
    }
  });

  it("refuses a relative result directory passed to the resolver directly", () => {
    expect(() =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcResultDir: "sidecars/results",
      })
    ).toThrow(/cfcResultDir must be an absolute host path/);
  });

  it("refuses a relative --cfc-result-dir rather than resolving it", async () => {
    // Resolving against the working directory is how one lands inside the
    // workspace, since the workspace defaults to that same directory.
    const errors: string[] = [];
    const exitCode = await runCfHarnessCli(
      ["--prompt", "hi", "--cfc-result-dir", "sidecars/results"],
      {
        io: {
          stdout: () => {},
          stderr: (line: string) => errors.push(line),
        },
      },
    );

    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("requires an absolute path");
  });
});

describe("host mount paths", () => {
  // Every host path that will be compared against another is walked apart
  // toward its root. A relative one has no root to reach, so the walk would
  // never end — and a run that hangs during construction never says why.

  it("refuses a relative workspace path", () => {
    expect(() =>
      resolveDockerRunscSandboxConfig({ workspaceHostPath: "project" })
    ).toThrow(/workspaceHostPath must be an absolute host path/);
  });

  it("refuses a relative artifact root", () => {
    // Not a mount, but it takes part in the comparison, so it is held to the
    // same rule as one.
    expect(() =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        artifactRootHostPath: "artifacts",
        cfcResultDir: "/elsewhere/sidecars",
      })
    ).toThrow(/artifactRootHostPath must be an absolute host path/);
  });

  it("refuses a relative additional-mount path", () => {
    expect(() =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        additionalMounts: [{
          kind: "host-bind",
          name: "data",
          hostPath: "data",
          sandboxPath: "/data",
          readOnly: false,
        }],
      })
    ).toThrow(/must be an absolute host path/);
  });
});
