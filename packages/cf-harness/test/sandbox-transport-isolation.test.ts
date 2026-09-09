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
import {
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "../src/sandbox/docker-runsc.ts";
import type {
  DockerRunscAdditionalMount,
  ResolveDockerRunscSandboxConfigOptions,
} from "../src/sandbox/types.ts";

describe("CFC sidecar transport isolation", () => {
  // The harness writes the invocation context a container starts tainted
  // from, and reads back the taint the run's evidence record is built from.
  // Neither claim survives the directory being writable by the workload it
  // describes: a container that can rewrite its own result sidecar names its
  // own taint.

  it("decides on the workspace path it was first given, and emits that one", () => {
    // The caller's object is data, and a property on it can be an accessor.
    // Checking one read and building the config from another is the whole
    // failure: the containment check passes against a workspace that never
    // reaches the mount, and the launch binds the one it never saw.
    // Counted per option, the list-valued ones included: a second read of any
    // of them is a second chance for the caller's object to answer
    // differently, whether or not this particular one lets a path escape.
    const reads: Record<string, number> = {};
    const options = {
      cfcResultDir: "/host/sidecars/results",
    } as ResolveDockerRunscSandboxConfigOptions;
    // Defined rather than spread: spreading an object of getters invokes them
    // at the spread and leaves plain data behind, so the count would be of
    // this test's own read and never of the resolver's.
    const counted = (name: string, value: unknown) =>
      Object.defineProperty(options, name, {
        enumerable: true,
        get: () => {
          reads[name] = (reads[name] ?? 0) + 1;
          return value;
        },
      });
    counted("workspaceHostPath", "/host/project");
    counted("additionalMounts", []);
    counted("extraDockerArgs", []);

    const config = resolveDockerRunscSandboxConfig(options);

    expect(reads).toEqual({
      workspaceHostPath: 1,
      additionalMounts: 1,
      extraDockerArgs: 1,
    });
    expect(config.workspaceHostPath).toBe("/host/project");
    expect(config.cfcResultDir).toBe("/host/sidecars/results");
  });

  it("emits the workspace path it was first given, whatever a later read says", () => {
    // The consequence the count exists for: a getter that changes after the
    // first read must not be able to pass the containment check on one path
    // and put another in the config the launch binds.
    let reads = 0;
    const config = resolveDockerRunscSandboxConfig({
      get workspaceHostPath() {
        reads += 1;
        return reads === 1 ? "/host/project" : "/host/sidecars";
      },
      cfcResultDir: "/host/sidecars/results",
    });

    expect(config.workspaceHostPath).toBe("/host/project");
  });

  it("launches from mounts no later hand can move", () => {
    // The check runs once over these paths and the launch reads them again.
    // A caller holding the config it constructed the runtime with must not be
    // able to move a mount between those two reads, push another, or flip a
    // checked read-only mount to writable.
    const config = resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      additionalMounts: [{
        kind: "host-bind",
        name: "docs",
        hostPath: "/host/docs",
        sandboxPath: "/docs",
        readOnly: true,
      }],
    });
    const mutable = {
      ...config,
      additionalMounts: config.additionalMounts.map((mount) => ({ ...mount })),
    };
    const runtime = new DockerRunscSandboxRuntime(mutable);

    mutable.workspaceHostPath = "/host/elsewhere";
    (mutable.additionalMounts as DockerRunscAdditionalMount[])[0] = {
      kind: "host-bind",
      name: "docs",
      hostPath: "/host/docs",
      sandboxPath: "/docs",
      readOnly: false,
    };

    const mounts = runtime.describe().cfc?.mounts ?? [];
    expect(mounts[0]?.hostPath).toBe("/host/project");
    expect(mounts[1]?.readOnly).toBe(true);
  });

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
