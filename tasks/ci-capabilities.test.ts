import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  BINARY_CACHE_DIR,
  CACHE_DIR,
  CAPABILITIES,
  type Capability,
  type CapabilityId,
  COMPILE_CACHE_FILE,
  openCapabilities,
  pidOfBackgroundLaunch,
  resolveCapabilities,
  takeGithubToken,
} from "./ci-capabilities.ts";
import {
  serverExecutionCiLane,
  type ServerExecutionCiRole,
} from "./server-execution-ci.ts";

/** A capability exporting `env`, built on `needs`. */
function stub(
  id: CapabilityId,
  env: Record<string, string>,
  needs?: readonly CapabilityId[],
): Capability {
  return {
    id,
    description: `a capability exporting ${Object.keys(env).join(", ")}`,
    ...(needs === undefined ? {} : { needs }),
    open: () => Promise.resolve({ env, close: () => Promise.resolve() }),
  };
}

/**
 * Runs `body` with each named variable set as given, `undefined` meaning
 * unset, and puts back what the environment held before. Every name a
 * case depends on is named here rather than left to the ambient
 * environment, since a token a developer exported is exactly what these
 * read. The names are written out rather than taken from the source,
 * because what a lane is handed a token in has to be what a workflow
 * writes.
 */
function withEnv(
  values: Record<string, string | undefined>,
  body: () => void,
): void {
  const before = new Map(
    Object.keys(values).map((name) => [name, Deno.env.get(name)]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  try {
    body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

describe("ci capabilities", () => {
  it("opens what a capability is built on before the capability", () => {
    const order = resolveCapabilities(["toolshed"]);
    expect(order.indexOf("deno")).toBeLessThan(order.indexOf("toolshed"));
  });

  it("opens each capability once however many suites asked for it", () => {
    const order = resolveCapabilities(["toolshed", "cf", "toolshed", "deno"]);
    expect(order.length).toBe(new Set(order).size);
    expect(order.filter((id) => id === "deno").length).toBe(1);
  });

  it("comes to the same order whatever order the requests arrived in", () => {
    const one = resolveCapabilities(["browser", "cf", "jq", "toolshed"]);
    const other = resolveCapabilities(["toolshed", "jq", "cf", "browser"]);
    expect(one).toEqual(other);
  });

  it("refuses a capability nothing declares", () => {
    expect(() => resolveCapabilities(["invented" as CapabilityId])).toThrow(
      "no such capability",
    );
  });

  it("declares only capabilities that are built on declared ones", () => {
    for (const capability of CAPABILITIES.values()) {
      for (const need of capability.needs ?? []) {
        expect(
          [capability.id, CAPABILITIES.has(need)],
        ).toEqual([capability.id, true]);
      }
    }
  });

  it("holds one capability for every name a suite may ask for", () => {
    // The registry is keyed by each entry's own identifier, so comparing
    // the two says nothing. What can go wrong is a name added to the
    // type and not to the registry, or the other way round, and a suite
    // asking for one that is not there fails the lane before it starts.
    expect([...CAPABILITIES.keys()].toSorted()).toEqual([
      "bg-piece-service-binary",
      "browser",
      "cf",
      "compile-cache",
      "deno",
      "fuse",
      "git-history",
      "github-api",
      "jq",
      "local-dev-servers",
      "toolshed",
      "toolshed-baked",
      "toolshed-baked-opposite",
    ]);
  });

  it("hands the token to the suites that asked and to no others", async () => {
    const opened = await openCapabilities(["github-api", "jq"], {
      root: Deno.cwd(),
      dryRun: false,
      workDir: "/nonexistent",
      exec: () => Promise.resolve(""),
      githubToken: "a-token",
    });
    // Under both names, because the two consumers read different ones:
    // `gh` reads `GH_TOKEN`, and `check-action-pins` reads
    // `GITHUB_TOKEN` first.
    expect(opened.envFor(["github-api"])).toEqual({
      GITHUB_TOKEN: "a-token",
      GH_TOKEN: "a-token",
    });
    expect(opened.envFor(["jq"])).toEqual({});
    await opened.close();
  });

  it("exports nothing where the lane was handed no token", async () => {
    const opened = await openCapabilities(["github-api"], {
      root: Deno.cwd(),
      dryRun: false,
      workDir: "/nonexistent",
      exec: () => Promise.resolve(""),
    });
    expect(opened.envFor(["github-api"])).toEqual({});
    await opened.close();
  });

  it("takes the token out of this process under either name", () => {
    // A token under a name this left behind would be inherited by every
    // child of the lane, and `check-action-pins` would pass on it, so
    // nothing downstream would report the hole.
    withEnv({ GITHUB_TOKEN: "a-token", GH_TOKEN: "another-token" }, () => {
      expect(takeGithubToken()).toBe("a-token");
      expect(Deno.env.get("GITHUB_TOKEN")).toBeUndefined();
      expect(Deno.env.get("GH_TOKEN")).toBeUndefined();
      expect(takeGithubToken()).toBeUndefined();
    });
  });

  it("takes a token handed under the second name alone", () => {
    withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: "a-token" }, () => {
      expect(takeGithubToken()).toBe("a-token");
      expect(Deno.env.get("GH_TOKEN")).toBeUndefined();
    });
  });

  it("reads an empty token as no token", () => {
    // An unset Actions variable interpolates as an empty string.
    withEnv({ GITHUB_TOKEN: "", GH_TOKEN: "" }, () => {
      expect(takeGithubToken()).toBeUndefined();
      expect(Deno.env.get("GITHUB_TOKEN")).toBeUndefined();
      expect(Deno.env.get("GH_TOKEN")).toBeUndefined();
    });
  });

  it("exports the environment a dry run's batches would see", async () => {
    const opened = await openCapabilities(["toolshed"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    });
    expect(opened.envFor(["toolshed"]).API_URL).toBe("http://localhost:8000");
    expect(opened.timings.map((timing) => timing.capability)).toEqual([
      "deno",
      "toolshed",
    ]);
    await opened.close();
  });

  it("closes what it opened when a later capability fails", async () => {
    const closed: string[] = [];
    const registry = new Map(CAPABILITIES);
    registry.set("cf", {
      id: "cf",
      description: "a capability that closes when told",
      open: () =>
        Promise.resolve({
          env: {},
          close: () => {
            closed.push("cf");
            return Promise.resolve();
          },
        }),
    });
    registry.set("jq", {
      id: "jq",
      description: "a capability that cannot open",
      // Ordered after `cf` by the alphabetical walk, so `cf` is already
      // open when this one fails.
      open: () => Promise.reject(new Error("no jq here")),
    });
    await expect(
      openCapabilities(["cf", "jq"], {
        root: Deno.cwd(),
        dryRun: true,
        workDir: "/nonexistent",
      }, registry),
    ).rejects.toThrow("no jq here");
    expect(closed).toEqual(["cf"]);
  });

  it("keeps what it caches where the workflow's one cache step looks", () => {
    // The lane's own working directory is made fresh every run, so
    // anything kept there would be rebuilt every time however well the
    // cache step worked. The workflow carries one fixed step over one
    // directory, so everything a lane wants restored sits inside it.
    expect(CACHE_DIR).toBe(".ci-cache");
    for (const kept of [BINARY_CACHE_DIR, COMPILE_CACHE_FILE]) {
      expect([kept, kept.startsWith(`${CACHE_DIR}/`)]).toEqual([kept, true]);
    }
  });

  it("says what every capability would export without opening one", async () => {
    // A dry run is the plan a lane prints when it has no machine to run
    // on, so every capability has to answer without touching anything.
    const opened = await openCapabilities([...CAPABILITIES.keys()], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    });
    expect(opened.timings.length).toBe(CAPABILITIES.size);
    // The two servers export the addresses their suites reach them at,
    // and the command line exports the path it is found on.
    const every = opened.envFor([...CAPABILITIES.keys()]);
    expect(every.API_URL).toBeDefined();
    expect(every.TOOLSHED_PORT).toBeDefined();
    expect(every.CF_LABS_ROOT).toBe(Deno.cwd());
    expect(every.BG_PIECE_SERVICE_BIN).toBe(
      `${Deno.cwd()}/${BINARY_CACHE_DIR}/bg-piece-service`,
    );
    expect(every.PATH?.startsWith(`${Deno.cwd()}/bin`)).toBe(true);
    expect(every.CF_COMPILE_CACHE_FILE).toBe(
      `${Deno.cwd()}/${COMPILE_CACHE_FILE}`,
    );
    await opened.close();
  });

  it("gives a suite the addresses its own server is listening on", async () => {
    // Both Toolshed capabilities export the address theirs is listening
    // on, and a lane may hold the default and opposite server-execution
    // arms at once.
    const registry = new Map<CapabilityId, Capability>([
      ["toolshed", stub("toolshed", { API_URL: "http://default.test" })],
      [
        "toolshed-baked-opposite",
        stub("toolshed-baked-opposite", { API_URL: "http://opposite.test" }),
      ],
    ]);
    const opened = await openCapabilities(
      ["toolshed", "toolshed-baked-opposite"],
      { root: Deno.cwd(), dryRun: true, workDir: "/nonexistent" },
      registry,
    );
    try {
      expect(opened.envFor(["toolshed"]).API_URL).toBe("http://default.test");
      expect(opened.envFor(["toolshed-baked-opposite"]).API_URL)
        .toBe("http://opposite.test");
    } finally {
      await opened.close();
    }
  });

  it("gives a suite what the capabilities under its own export too", async () => {
    // A suite names one capability, and the batch runs with what
    // everything under that one exports as well.
    const registry = new Map<CapabilityId, Capability>([
      ["deno", stub("deno", { UNDERNEATH: "yes" })],
      ["cf", stub("cf", { NAMED: "yes" }, ["deno"])],
    ]);
    const opened = await openCapabilities(["cf"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    }, registry);
    try {
      expect(opened.envFor(["cf"])).toEqual({
        UNDERNEATH: "yes",
        NAMED: "yes",
      });
    } finally {
      await opened.close();
    }
  });

  it("closes what it opened, in the reverse of the opening order", async () => {
    const closed: string[] = [];
    const registry = new Map(CAPABILITIES);
    for (const id of ["deno", "jq", "cf"] as const) {
      registry.set(id, {
        // The real one's dependencies are kept, because what is being
        // checked is the order those put the openings in.
        ...CAPABILITIES.get(id)!,
        description: "a capability that says when it closes",
        open: () =>
          Promise.resolve({
            env: {},
            close: () => {
              closed.push(id);
              return Promise.resolve();
            },
          }),
      });
    }
    const opened = await openCapabilities(["cf", "jq"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    }, registry);
    await opened.close();
    // Opened deno, cf, jq; closed in reverse.
    expect(closed).toEqual(["jq", "cf", "deno"]);
  });

  it("keeps going when one capability cannot be closed", async () => {
    // A capability that throws on the way out must not strand the ones
    // after it: the lane is finishing either way.
    const closed: string[] = [];
    const registry = new Map(CAPABILITIES);
    registry.set("deno", {
      ...CAPABILITIES.get("deno")!,
      description: "a capability that closes when told",
      open: () =>
        Promise.resolve({
          env: {},
          close: () => {
            closed.push("deno");
            return Promise.resolve();
          },
        }),
    });
    registry.set("jq", {
      ...CAPABILITIES.get("jq")!,
      // Built on the one above, so that one is still open behind it when
      // this one refuses to close.
      needs: ["deno"],
      description: "a capability that cannot be closed",
      open: () =>
        Promise.resolve({
          env: {},
          close: () => Promise.reject(new Error("stuck")),
        }),
    });
    const opened = await openCapabilities(["jq"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    }, registry);
    await opened.close();
    expect(closed).toEqual(["deno"]);
  });

  it("runs a real command, and carries its output into the failure", async () => {
    // The default runner, which is what a lane uses. Setup that
    // half-worked is worse than setup that did not, so a command that
    // fails throws with what it said rather than being read as success.
    const repo = await Deno.makeTempDir({ prefix: "capability-git-" });
    await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output();
    const opened = await openCapabilities(["git-history"], {
      root: repo,
      dryRun: false,
      workDir: repo,
    });
    await opened.close();

    // The same runner against a repository that is not one.
    const empty = await Deno.makeTempDir({ prefix: "capability-nogit-" });
    await expect(
      openCapabilities(["git-history"], {
        root: empty,
        dryRun: false,
        workDir: empty,
      }),
    ).rejects.toThrow("git rev-parse");
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(empty, { recursive: true });
  });

  it("reads the process a background launch detached", () => {
    expect(
      pidOfBackgroundLaunch(
        "Toolshed is listening; the server is running in the background " +
          "(pid 4213). Logs: /tmp/toolshed.log",
      ),
    ).toBe(4213);
    expect(pidOfBackgroundLaunch("no process here")).toBeUndefined();
  });
});

describe("opening a capability on a machine that answers", () => {
  /** What a capability asked the machine, and what it was told. */
  function machine(answers: Record<string, string> = {}) {
    const asked: string[] = [];
    const envs: Array<Record<string, string> | undefined> = [];
    const exec = (
      command: string,
      args: readonly string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ): Promise<string> => {
      const line = [command, ...args].join(" ");
      asked.push(line);
      envs.push(options?.env);
      for (const [match, answer] of Object.entries(answers)) {
        if (line.includes(match)) {
          return answer.startsWith("!")
            ? Promise.reject(new Error(answer.slice(1)))
            : Promise.resolve(answer);
        }
      }
      return Promise.resolve("");
    };
    return { asked, envs, exec };
  }

  /** The environment the machine was given for the call naming `match`. */
  function envOf(m: ReturnType<typeof machine>, match: string) {
    return m.envs[m.asked.findIndex((line) => line.includes(match))];
  }

  /** A server answering what one on `role` answers. */
  function serving(role: ServerExecutionCiRole): typeof fetch {
    const lane = serverExecutionCiLane(role);
    const bodies: Record<string, unknown> = {
      "/api/meta": {
        experimental: { serverExecution: lane.enabled },
        shellServerExecutionDefine: lane.experimentalValue ?? null,
      },
      "/api/health/stats": { servingLoop: lane.enabled ? 1 : null },
    };
    return (input) =>
      Promise.resolve(
        Response.json(bodies[new URL(String(input)).pathname] ?? {}),
      );
  }

  async function open(
    id: CapabilityId,
    m: ReturnType<typeof machine>,
    role: ServerExecutionCiRole = "default",
  ) {
    const root = await Deno.makeTempDir({ prefix: "capability-" });
    try {
      const opened = await openCapabilities([id], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
        fetch: serving(role),
      }, CAPABILITIES);
      await opened.close();
      return { opened, root };
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }

  it("installs the FUSE packages only where one is missing", async () => {
    // Every probe answering means the packages are already there, and
    // an install that runs anyway costs the lane fifteen seconds it did
    // not need to spend.
    const present = machine();
    await open("fuse", present);
    expect(present.asked.some((line) => line.includes("apt-get install")))
      .toBe(false);
    expect(present.asked.some((line) => line.includes("chmod 666 /dev/fuse")))
      .toBe(true);

    // The runner image carries the FUSE runtime and not its development
    // files, so `fusermount3` answers while the library the mount opens
    // is absent. What the probe asks has to be the library.
    const library = machine({
      "pkg-config --exists fuse3": "!no such package",
    });
    await open("fuse", library);
    expect(library.asked.some((line) => line.includes("libfuse3-dev")))
      .toBe(true);

    // The unmount runs `fusermount3`, which the development files do not
    // carry, so the runtime package gets a probe of its own.
    const runtime = machine({ "command -v fusermount3": "!not found" });
    await open("fuse", runtime);
    expect(runtime.asked.some((line) => line.includes("apt-get install")))
      .toBe(true);

    const missing = machine({ "command -v gcc": "!not found" });
    await open("fuse", missing);
    expect(missing.asked.some((line) => line.includes("apt-get update")))
      .toBe(true);
    expect(
      missing.asked.some((line) => line.includes("libfuse3-dev")),
    ).toBe(true);
  });

  it("unshallows a checkout only where it is shallow", async () => {
    const shallow = machine({ "is-shallow-repository": "true\n" });
    await open("git-history", shallow);
    expect(shallow.asked.some((line) => line.includes("fetch --unshallow")))
      .toBe(true);

    const whole = machine({ "is-shallow-repository": "false\n" });
    await open("git-history", whole);
    expect(whole.asked.some((line) => line.includes("fetch --unshallow")))
      .toBe(false);
  });

  it("relaxes the namespace only on an image that restricts it", async () => {
    // A capability that insisted on the knob would fail every lane on a
    // machine that never restricted the namespace in the first place,
    // and one that never looked would leave the browser unable to start
    // where it did.
    const restricted = machine();
    await open("browser", restricted);
    expect(restricted.asked.some((line) => line.includes("sudo tee")))
      .toBe(true);

    const unrestricted = machine({
      "test -e /proc/sys/kernel/apparmor": "!no such file",
    });
    await open("browser", unrestricted);
    expect(unrestricted.asked.some((line) => line.includes("sudo tee")))
      .toBe(false);
  });

  it("starts a server on a port of its own and kills what it started", async () => {
    const m = machine({ "index.ts": "listening (pid 999999). Logs: x\n" });
    const { opened } = await open("toolshed", m);
    const served = opened.envFor(["toolshed"]);
    const port = Number(served.TOOLSHED_PORT);
    expect(Number.isInteger(port) && port > 0).toBe(true);
    // No trailing slash: the shell suites compose a path onto this, and
    // the Deno suites add a slash of their own when they need one.
    expect(served.API_URL).toBe(`http://localhost:${port}`);
    expect(m.asked.some((line) => line.includes(`--port=${port}`))).toBe(true);
    expect(m.asked.some((line) => line.includes("--background"))).toBe(true);
    // Closing is what `open` already did; killing a process this test
    // invented would be worse than not checking, and what matters is
    // that it does not throw.
  });

  it("holds a server it started to the arm it started it for", async () => {
    // A server on the other arm answers every request the suites make
    // and passes, so the run reports that the arm it named works when
    // nothing exercised it.
    const answers = { "index.ts": "listening (pid 999999). Logs: x\n" };
    await open("toolshed", machine(answers), "default");

    const wrong = machine(answers);
    await expect(open("toolshed", wrong, "opposite")).rejects.toThrow(
      "default lane publishes serverExecution",
    );
  });

  it("gives a server the define its own role names", async () => {
    // A lane holding both arms carries one value in its ambient
    // environment, and the shell bakes in whatever the build saw. The
    // define a server builds and runs under is the one its role names:
    // the value for the opposite arm, and none at all for the default.
    const named = serverExecutionCiLane("opposite").experimentalValue;
    const before = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
    Deno.env.set(
      "EXPERIMENTAL_SERVER_EXECUTION",
      named === "true" ? "false" : "true",
    );
    try {
      const source = machine({
        "index.ts": "listening (pid 999999). Logs: x\n",
      });
      await open("toolshed", source);
      expect(envOf(source, "index.ts")?.EXPERIMENTAL_SERVER_EXECUTION)
        .toBeUndefined();

      const baked = await openBaked(
        "toolshed-baked",
        "toolshed-baked-default",
        "default",
      );
      expect(envOf(baked, "build-binaries")?.EXPERIMENTAL_SERVER_EXECUTION)
        .toBeUndefined();
      expect(
        envOf(baked, "toolshed-baked-default")?.EXPERIMENTAL_SERVER_EXECUTION,
      ).toBeUndefined();

      const opposite = await openBaked(
        "toolshed-baked-opposite",
        "toolshed-baked-opposite",
        "opposite",
      );
      expect(envOf(opposite, "build-binaries")?.EXPERIMENTAL_SERVER_EXECUTION)
        .toBe(named);
      expect(
        envOf(opposite, "toolshed-baked-opposite")
          ?.EXPERIMENTAL_SERVER_EXECUTION,
      ).toBe(named);
    } finally {
      if (before === undefined) {
        Deno.env.delete("EXPERIMENTAL_SERVER_EXECUTION");
      } else {
        Deno.env.set("EXPERIMENTAL_SERVER_EXECUTION", before);
      }
    }
  });

  it("refuses a launch that names no process to kill later", async () => {
    // A server nobody can kill outlives the lane and holds its port
    // against the next one.
    const m = machine({ "index.ts": "started somehow\n" });
    await expect(open("toolshed", m)).rejects.toThrow("named no process");
  });

  /** Opens a baked capability against a root that has no binary yet. */
  async function openBaked(
    id: CapabilityId,
    binaryName: string,
    role: ServerExecutionCiRole,
  ) {
    const m = machine({ [binaryName]: "listening (pid 999999). Logs: x\n" });
    const root = await Deno.makeTempDir({ prefix: "capability-" });
    try {
      // What a build leaves behind, so the copy into the cache has
      // something to copy.
      await Deno.mkdir(`${root}/dist`, { recursive: true });
      await Deno.writeTextFile(`${root}/dist/toolshed`, "");
      const opened = await openCapabilities([id], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
        fetch: serving(role),
      }, CAPABILITIES);
      await opened.close();
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
    return m;
  }

  it("builds the server-execution binary only when none was restored", async () => {
    const binaryName = "toolshed-baked-opposite";
    const answers = {
      [binaryName]: "listening (pid 999999). Logs: x\n",
    };
    const openOpposite = async (restored: boolean) => {
      const m = machine(answers);
      const root = await Deno.makeTempDir({ prefix: "capability-" });
      // What a build leaves behind, so the copy into the cache has
      // something to copy.
      await Deno.mkdir(`${root}/dist`, { recursive: true });
      await Deno.writeTextFile(`${root}/dist/toolshed`, "");
      if (restored) {
        await Deno.mkdir(`${root}/${BINARY_CACHE_DIR}`, { recursive: true });
        await Deno.writeTextFile(
          `${root}/${BINARY_CACHE_DIR}/${binaryName}`,
          "",
        );
      }
      const opened = await openCapabilities(["toolshed-baked-opposite"], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
        fetch: serving("opposite"),
      }, CAPABILITIES);
      await opened.close();
      await Deno.remove(root, { recursive: true });
      return m.asked.some((line) => line.includes("build-binaries toolshed"));
    };
    // A cache miss builds; a restore does not, which is the difference
    // between forty seconds and seventeen on every lane that needs it.
    expect(await openOpposite(false)).toBe(true);
    expect(await openOpposite(true)).toBe(false);
  });

  it("builds the background service binary only when none was restored", async () => {
    const openBinary = async (restored: boolean) => {
      const m = machine();
      const root = await Deno.makeTempDir({ prefix: "capability-" });
      await Deno.mkdir(`${root}/dist`, { recursive: true });
      await Deno.writeTextFile(`${root}/dist/bg-piece-service`, "");
      if (restored) {
        await Deno.mkdir(`${root}/${BINARY_CACHE_DIR}`, { recursive: true });
        await Deno.writeTextFile(
          `${root}/${BINARY_CACHE_DIR}/bg-piece-service`,
          "",
        );
      }
      const opened = await openCapabilities(["bg-piece-service-binary"], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
      }, CAPABILITIES);
      await opened.close();
      await Deno.remove(root, { recursive: true });
      return m.asked.some((line) =>
        line.includes("build-binaries bg-piece-service")
      );
    };
    expect(await openBinary(false)).toBe(true);
    expect(await openBinary(true)).toBe(false);
  });
});

describe("a registry that cannot be opened in any order", () => {
  it("refuses a capability built on itself", () => {
    // A cycle has no order to open in, and the walk would otherwise
    // recur until the stack ran out rather than saying what is wrong.
    const registry = new Map(CAPABILITIES);
    registry.set("jq", {
      ...CAPABILITIES.get("jq")!,
      needs: ["cf"],
    });
    registry.set("cf", {
      ...CAPABILITIES.get("cf")!,
      needs: ["jq"],
    });
    expect(() => resolveCapabilities(["jq"], registry)).toThrow(
      "built on itself",
    );
  });
});

describe("the compile cache a lane hands the pattern suites", () => {
  it("makes the directory the workflow's cache step restores into", async () => {
    // The compiler is pointed at a file, and it cannot write one into a
    // directory that is not there — so a cache that was never restored
    // has to become an empty one rather than a failure.
    const root = await Deno.makeTempDir({ prefix: "compile-cache-" });
    try {
      const opened = await openCapabilities(["compile-cache"], {
        root,
        dryRun: false,
        workDir: root,
      });
      expect(opened.envFor(["compile-cache"]).CF_COMPILE_CACHE_FILE).toBe(
        `${root}/${COMPILE_CACHE_FILE}`,
      );
      expect((await Deno.stat(`${root}/${CACHE_DIR}/compile`)).isDirectory)
        .toBe(true);
      await opened.close();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
