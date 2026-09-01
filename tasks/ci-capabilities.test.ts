import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  BINARY_CACHE_DIR,
  CACHE_DIR,
  CAPABILITIES,
  type CapabilityId,
  COMPILE_CACHE_FILE,
  openCapabilities,
  pidOfBackgroundLaunch,
  resolveCapabilities,
} from "./ci-capabilities.ts";

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
      "browser",
      "cf",
      "compile-cache",
      "deno",
      "fuse",
      "git-history",
      "jq",
      "local-dev-servers",
      "toolshed",
      "toolshed-baked-on",
    ]);
  });

  it("exports the environment a dry run's batches would see", async () => {
    const opened = await openCapabilities(["toolshed"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    });
    expect(opened.env.API_URL).toBe("http://localhost:8000/");
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
    expect(opened.env.API_URL).toBeDefined();
    expect(opened.env.TOOLSHED_PORT).toBeDefined();
    expect(opened.env.CF_LABS_ROOT).toBe(Deno.cwd());
    expect(opened.env.PATH?.startsWith(`${Deno.cwd()}/bin`)).toBe(true);
    expect(opened.env.CF_COMPILE_CACHE_FILE).toBe(
      `${Deno.cwd()}/${COMPILE_CACHE_FILE}`,
    );
    await opened.close();
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
    const exec = (
      command: string,
      args: readonly string[],
    ): Promise<string> => {
      const line = [command, ...args].join(" ");
      asked.push(line);
      for (const [match, answer] of Object.entries(answers)) {
        if (line.includes(match)) {
          return answer.startsWith("!")
            ? Promise.reject(new Error(answer.slice(1)))
            : Promise.resolve(answer);
        }
      }
      return Promise.resolve("");
    };
    return { asked, exec };
  }

  async function open(id: CapabilityId, m: ReturnType<typeof machine>) {
    const root = await Deno.makeTempDir({ prefix: "capability-" });
    try {
      const opened = await openCapabilities([id], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
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

    const missing = machine({ "command -v fusermount3": "!not found" });
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
    const port = Number(opened.env.TOOLSHED_PORT);
    expect(Number.isInteger(port) && port > 0).toBe(true);
    expect(opened.env.API_URL).toBe(`http://localhost:${port}/`);
    expect(m.asked.some((line) => line.includes(`--port=${port}`))).toBe(true);
    expect(m.asked.some((line) => line.includes("--background"))).toBe(true);
    // Closing is what `open` already did; killing a process this test
    // invented would be worse than not checking, and what matters is
    // that it does not throw.
  });

  it("refuses a launch that names no process to kill later", async () => {
    // A server nobody can kill outlives the lane and holds its port
    // against the next one.
    const m = machine({ "index.ts": "started somehow\n" });
    await expect(open("toolshed", m)).rejects.toThrow("named no process");
  });

  it("builds the server-execution binary only when none was restored", async () => {
    const answers = { "toolshed-on": "listening (pid 999999). Logs: x\n" };
    const openOn = async (restored: boolean) => {
      const m = machine(answers);
      const root = await Deno.makeTempDir({ prefix: "capability-" });
      // What a build leaves behind, so the copy into the cache has
      // something to copy.
      await Deno.mkdir(`${root}/dist`, { recursive: true });
      await Deno.writeTextFile(`${root}/dist/toolshed`, "");
      if (restored) {
        await Deno.mkdir(`${root}/${BINARY_CACHE_DIR}`, { recursive: true });
        await Deno.writeTextFile(`${root}/${BINARY_CACHE_DIR}/toolshed-on`, "");
      }
      const opened = await openCapabilities(["toolshed-baked-on"], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
      }, CAPABILITIES);
      await opened.close();
      await Deno.remove(root, { recursive: true });
      return m.asked.some((line) => line.includes("build-binaries toolshed"));
    };
    // A cache miss builds; a restore does not, which is the difference
    // between forty seconds and seventeen on every lane that needs it.
    expect(await openOn(false)).toBe(true);
    expect(await openOn(true)).toBe(false);
  });
});
