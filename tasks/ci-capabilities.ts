/**
 * The environment a suite needs before it can run, named rather than
 * implied.
 *
 * A lane works out the union of what its batches need, opens each one
 * once, and runs the batches inside it. Naming them is what lets two ways
 * of providing the same thing coexist: `toolshed` runs a server from
 * source, which is cheap enough for a pull request, while
 * `toolshed-baked-on` restores or builds a binary because the
 * server-execution ON posture is baked into the browser shell inside it
 * and a source run cannot reproduce that. A suite says which it needs and
 * neither the workflow nor the other suites know the difference.
 *
 * Every capability is idempotent: opening one that is already open is the
 * same as not opening it. The lane runner relies on that when a batch it
 * did not plan for turns out to need something already standing.
 */

import * as path from "@std/path";

/** Every piece of setup a suite may ask for. */
export type CapabilityId =
  | "deno"
  | "fuse"
  | "jq"
  | "browser"
  | "git-history"
  | "toolshed"
  | "toolshed-baked-on"
  | "cf"
  | "local-dev-servers"
  | "compile-cache";

/**
 * Running a command, as a capability does it: the output on success, and
 * a throw carrying that output on failure. Setup that half-worked is
 * worse than setup that did not, because the batch after it fails
 * somewhere unrelated.
 */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<string>;

/** What a capability was given to work with. */
export interface CapabilityContext {
  /** The repository root, absolute. */
  root: string;

  /**
   * Report what would happen and change nothing. A dry-run capability
   * still returns the environment it would export, so a plan printed
   * without a machine to run it on says what the batches would see.
   */
  dryRun: boolean;

  /**
   * Where a capability may write files it owns, such as a restored
   * compile cache or a server log.
   */
  workDir: string;

  /**
   * How a capability runs a command. A caller that supplies one is
   * saying what the machine would have answered, which is the only way
   * setup that installs packages and starts servers can be exercised
   * without a machine that has neither.
   */
  exec?: Exec;
}

/** A capability that has been opened. */
export interface OpenCapability {
  /** Environment the suites that asked for it run with. */
  env: Record<string, string>;

  /** Shuts it down. Called once, in the reverse of the opening order. */
  close(): Promise<void>;
}

/** One named piece of setup. */
export interface Capability {
  id: CapabilityId;

  /** What it provides, in words the job summary prints. */
  description: string;

  /**
   * Capabilities this one is built on. They are opened first, and their
   * environment is visible to this one.
   */
  needs?: readonly CapabilityId[];

  open(context: CapabilityContext): Promise<OpenCapability>;
}

/**
 * What a lane keeps between runs, relative to the repository root. The
 * lane's workflow carries one fixed cache step covering this directory,
 * so everything a lane wants restored has to sit inside it, and it has
 * to outlive the lane: a directory the lane made for itself would be
 * empty on every run, and everything in it would be built again.
 */
export const CACHE_DIR = ".ci-cache";

/** Where a built binary is kept, inside that directory. */
export const BINARY_CACHE_DIR = `${CACHE_DIR}/binaries`;

/** Where the pattern compile byte cache is kept, inside that directory. */
export const COMPILE_CACHE_FILE = `${CACHE_DIR}/compile/lane.json`;

/** Nothing to undo. */
const NOTHING = () => Promise.resolve();

/** A capability that exports environment and owns no process. */
function exported(env: Record<string, string>): OpenCapability {
  return { env, close: NOTHING };
}

/**
 * Runs a command, and throws with its output when it fails. Setup that
 * half-worked is worse than setup that did not, because the batch after
 * it fails somewhere unrelated.
 */
const run: Exec = async (command, args, options = {}) => {
  const result = await new Deno.Command(command, {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.success) return stdout;
  const stderr = new TextDecoder().decode(result.stderr);
  throw new Error(
    `${command} ${args.join(" ")} exited ${result.code}\n${stdout}${stderr}`,
  );
};

/** How this context runs commands. */
function execOf(context: CapabilityContext): Exec {
  return context.exec ?? run;
}

/** Whether a command is already on the path. */
async function onPath(exec: Exec, command: string): Promise<boolean> {
  try {
    await exec("sh", ["-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

/** Installs Debian packages, and does nothing where they are all present. */
async function apt(
  exec: Exec,
  packages: readonly string[],
  probes: readonly string[],
): Promise<void> {
  let missing = false;
  for (const probe of probes) {
    if (!await onPath(exec, probe)) missing = true;
  }
  if (!missing) return;
  await exec("sudo", ["apt-get", "update"]);
  await exec("sudo", [
    "apt-get",
    "install",
    "-y",
    "--no-install-recommends",
    ...packages,
  ]);
}

/**
 * The Deno toolchain and the workspace's dependencies. The lane's own job
 * has already done this through the setup actions, which is why opening
 * it is a check rather than an install: a lane that reached this code is
 * running under Deno, and a dependency install this could redo is one the
 * workflow already paid for.
 */
const deno: Capability = {
  id: "deno",
  description: "the Deno toolchain and the workspace's dependencies",
  open: () => Promise.resolve(exported({})),
};

const fuse: Capability = {
  id: "fuse",
  description: "the FUSE headers and tools the CLI's mount suite needs",
  async open(context) {
    if (!context.dryRun) {
      const exec = execOf(context);
      await apt(
        exec,
        ["pkg-config", "gcc", "libfuse3-dev", "fuse3"],
        ["pkg-config", "gcc", "fusermount3"],
      );
      // The mount itself needs the device, and the runner image leaves it
      // owned by root.
      await exec("sudo", ["chmod", "666", "/dev/fuse"]);
    }
    return exported({});
  },
};

const jq: Capability = {
  id: "jq",
  description: "jq, which the shell integration suites filter JSON with",
  async open(context) {
    if (!context.dryRun) await apt(execOf(context), ["jq"], ["jq"]);
    return exported({});
  },
};

/**
 * Astral drives Chrome through a user namespace, which Ubuntu's AppArmor
 * profile denies to unprivileged processes. Relaxing it is the whole of
 * what a browser test needs from the machine.
 */
const browser: Capability = {
  id: "browser",
  description: "the AppArmor relaxation a sandboxed browser needs",
  async open(context) {
    const sysctl = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
    if (!context.dryRun) {
      const exec = execOf(context);
      // Asked of the machine rather than of the filesystem directly, so
      // that an image with the knob and an image without it are the same
      // question with two answers rather than two code paths only one
      // machine can reach.
      try {
        await exec("sh", ["-c", `test -e ${sysctl}`]);
      } catch {
        // Nothing restricts the namespace here, so nothing needs
        // relaxing.
        return exported({});
      }
      await exec("sh", [
        "-c",
        `printf '0\\n' | sudo tee ${sysctl} >/dev/null`,
      ]);
    }
    return exported({});
  },
};

/**
 * A checkout deep enough to diff against a merge base and to replay a
 * recorded vintage. The lane's own checkout is already full depth, so
 * this is a repair for a shallow one rather than the usual path.
 */
const gitHistory: Capability = {
  id: "git-history",
  description: "an unshallowed checkout",
  async open(context) {
    if (!context.dryRun) {
      const exec = execOf(context);
      const shallow = (await exec("git", [
        "rev-parse",
        "--is-shallow-repository",
      ], { cwd: context.root })).trim();
      if (shallow === "true") {
        await exec("git", ["fetch", "--unshallow"], { cwd: context.root });
      }
    }
    return exported({});
  },
};

/** How a Toolshed server is started, whichever binary provides it. */
interface ToolshedOptions {
  /** The command that starts it, and where it runs. */
  command: readonly string[];
  cwd: string;

  /** Environment beyond the port, such as the server-execution define. */
  env: Record<string, string>;
}

/** The process identifier a background launch reports having detached. */
export function pidOfBackgroundLaunch(output: string): number | undefined {
  const match = /\(pid (\d+)\)/.exec(output);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Starts a Toolshed server and exports the addresses the suites reach it
 * at. `--background` is what makes this a single call: the launcher waits
 * for the server to report over a pipe that it has bound its port, then
 * detaches and prints the server's process identifier, so there is
 * nothing here to poll and nothing to wait a fixed time for. Killing that
 * process is the close, so a lane that opened a server leaves nothing
 * listening behind it.
 */
async function startToolshed(
  context: CapabilityContext,
  options: ToolshedOptions,
): Promise<OpenCapability> {
  // Port zero would leave the suites with no address to reach, so the
  // port is chosen here and the server is told which one to bind.
  const port = context.dryRun ? 8000 : freePort();
  const url = `http://localhost:${port}`;
  const env = {
    API_URL: `${url}/`,
    MEMORY_URL: url,
    TOOLSHED_URL: url,
    TOOLSHED_PORT: `${port}`,
  };
  if (context.dryRun) return exported(env);
  const [command, ...args] = options.command;
  const logFile = path.join(context.workDir, `toolshed-${port}.log`);
  const output = await execOf(context)(command!, [
    ...args,
    `--port=${port}`,
    "--background",
    `--log-file=${logFile}`,
  ], {
    cwd: options.cwd,
    env: {
      ...Deno.env.toObject(),
      // The server reaches for a gateway and a model key at startup. A
      // test server has neither.
      CFTS_AI_GATEWAY_URL: "",
      CFTS_AI_LLM_ANTHROPIC_API_KEY: "fake",
      ...options.env,
      ...env,
    },
  });
  const pid = pidOfBackgroundLaunch(output);
  if (pid === undefined) {
    throw new Error(`the toolshed launch named no process:\n${output}`);
  }
  return {
    env,
    close: () => {
      try {
        Deno.kill(pid, "SIGTERM");
      } catch {
        // Already gone, which is the state the close was after.
      }
      return Promise.resolve();
    },
  };
}

/**
 * A free TCP port, taken by listening on port zero and closing again. Two
 * servers in one lane must not collide, and a fixed port would collide
 * with whatever the runner image already has listening as well.
 */
function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/**
 * A Toolshed server run from source. A pull request that downloaded a
 * compiled binary would pay a build job on its critical path and a
 * download in every consumer; the dependency graph is already in the Deno
 * cache the workflow restored, so starting from source costs seconds.
 */
const toolshed: Capability = {
  id: "toolshed",
  description: "a Toolshed server, run from source on an allocated port",
  needs: ["deno"],
  open: (context) =>
    startToolshed(context, {
      command: [Deno.execPath(), "run", "--unstable-otel", "-A", "index.ts"],
      cwd: path.join(context.root, "packages", "toolshed"),
      env: {},
    }),
};

/**
 * The same server with server execution on, from a compiled binary. The
 * ON posture is a compile-time define baked into the browser shell inside
 * the binary, so a source run cannot reproduce it. The lane's workflow
 * restores the binary from the Actions cache before the runner starts;
 * building it here is what happens when that cache missed.
 */
const toolshedBakedOn: Capability = {
  id: "toolshed-baked-on",
  description:
    "a Toolshed server with the server-execution define baked into its shell",
  needs: ["deno"],
  async open(context) {
    const binary = path.join(context.root, BINARY_CACHE_DIR, "toolshed-on");
    if (!context.dryRun) {
      let present = true;
      try {
        await Deno.stat(binary);
      } catch {
        // The workflow's cache step found nothing to restore, so the
        // binary is built here instead. That is the slow path — about
        // forty seconds against seventeen for a restore — and it is what
        // the first run after a change to the sources pays.
        present = false;
      }
      if (!present) {
        await execOf(context)(
          Deno.execPath(),
          ["task", "build-binaries", "toolshed"],
          {
            cwd: context.root,
            env: {
              ...Deno.env.toObject(),
              EXPERIMENTAL_SERVER_EXECUTION: "true",
            },
          },
        );
        await Deno.mkdir(path.dirname(binary), { recursive: true });
        await Deno.copyFile(
          path.join(context.root, "dist", "toolshed"),
          binary,
        );
      }
      await Deno.chmod(binary, 0o755);
    }
    return await startToolshed(context, {
      command: [binary],
      cwd: context.root,
      env: { EXPERIMENTAL_SERVER_EXECUTION: "true" },
    });
  },
};

/**
 * The `cf` command line by name. `bin/cf` runs from source and works out
 * which checkout it belongs to, so putting the directory on the path is
 * the whole of it — no binary to build and nothing to download.
 */
const cf: Capability = {
  id: "cf",
  description: "the cf command line on the path, run from source",
  needs: ["deno"],
  open(context) {
    const bin = path.join(context.root, "bin");
    return Promise.resolve(exported({
      PATH: `${bin}${path.DELIMITER}${Deno.env.get("PATH") ?? ""}`,
      CF_LABS_ROOT: context.root,
    }));
  },
};

/**
 * The whole local development stack, brought up the way somebody working
 * on the repository brings it up. The reload suite needs this rather than
 * `toolshed`: its own task starts the stack, so a lane that had opened a
 * Toolshed server would have paid for the wrong thing and still failed.
 */
const localDevServers: Capability = {
  id: "local-dev-servers",
  description: "the local development stack on an allocated port offset",
  needs: ["deno"],
  // `deno task integration patterns-reload` brings the stack up and takes
  // it down around its own run. Declaring the capability is what keeps
  // that suite from being packed beside one that opened a Toolshed
  // server, which is a different server on a different port.
  open: () => Promise.resolve(exported({})),
};

/**
 * The byte cache that lets an unchanged pattern reuse the last run's
 * emitted bytes. The workflow's cache action puts the file in place; this
 * points the compiler at it and gives it somewhere to write when the
 * action found nothing.
 */
const compileCache: Capability = {
  id: "compile-cache",
  description: "the pattern compile byte cache",
  async open(context) {
    const file = path.join(context.root, COMPILE_CACHE_FILE);
    if (!context.dryRun) {
      await Deno.mkdir(path.dirname(file), { recursive: true });
    }
    return exported({ CF_COMPILE_CACHE_FILE: file });
  },
};

/** Every capability, by name. */
export const CAPABILITIES: ReadonlyMap<CapabilityId, Capability> = new Map(
  ([
    deno,
    fuse,
    jq,
    browser,
    gitHistory,
    toolshed,
    toolshedBakedOn,
    cf,
    localDevServers,
    compileCache,
  ] as const).map((capability) => [capability.id, capability]),
);

/**
 * The capabilities a set of requests comes to, in the order they open.
 * A capability built on another appears after it, and each appears once
 * however many suites asked for it.
 */
export function resolveCapabilities(
  requested: Iterable<CapabilityId>,
  registry: ReadonlyMap<CapabilityId, Capability> = CAPABILITIES,
): CapabilityId[] {
  const order: CapabilityId[] = [];
  const placed = new Set<CapabilityId>();
  const visiting = new Set<CapabilityId>();
  const visit = (id: CapabilityId): void => {
    if (placed.has(id)) return;
    const capability = registry.get(id);
    if (capability === undefined) {
      throw new Error(`no such capability: ${id}`);
    }
    if (visiting.has(id)) {
      throw new Error(`capability ${id} is built on itself`);
    }
    visiting.add(id);
    for (const need of capability.needs ?? []) visit(need);
    visiting.delete(id);
    placed.add(id);
    order.push(id);
  };
  // Sorted first, so the same set opens in the same order whatever order
  // the batches were planned in.
  for (const id of [...requested].sort()) visit(id);
  return order;
}

/** What opening a set of capabilities produced. */
export interface OpenedCapabilities {
  /** The environment every batch runs with, the requests merged in order. */
  env: Record<string, string>;

  /** Seconds each capability's setup took, in the order they opened. */
  timings: Array<{ capability: CapabilityId; seconds: number }>;

  /** Closes them all, in the reverse of the order they opened. */
  close(): Promise<void>;
}

/**
 * Opens every capability the requests come to, once each, and measures
 * what each took. The measurements are what the publisher fits
 * `setupCost` from, so they are the point of this returning anything
 * beyond the environment.
 */
export async function openCapabilities(
  requested: Iterable<CapabilityId>,
  context: CapabilityContext,
  registry: ReadonlyMap<CapabilityId, Capability> = CAPABILITIES,
): Promise<OpenedCapabilities> {
  const env: Record<string, string> = {};
  const timings: Array<{ capability: CapabilityId; seconds: number }> = [];
  const opened: OpenCapability[] = [];
  const close = async (): Promise<void> => {
    for (const capability of opened.reverse()) {
      try {
        await capability.close();
      } catch (error) {
        console.warn(`ci-lane: closing a capability failed: ${error}`);
      }
    }
    opened.length = 0;
  };
  try {
    for (const id of resolveCapabilities(requested, registry)) {
      const capability = registry.get(id)!;
      const startedAt = performance.now();
      const open = await capability.open(context);
      opened.push(open);
      Object.assign(env, open.env);
      timings.push({
        capability: id,
        seconds: (performance.now() - startedAt) / 1000,
      });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { env, timings, close };
}
