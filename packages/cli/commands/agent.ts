import { Command, ValidationError } from "@cliffy/command";
import { join } from "@std/path";

import {
  experimentalOptionsForDeployedClient,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { agentQueueIndexCell } from "@commonfabric/runner/agent-run";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createHarnessAgentRunExecutor } from "../lib/agent-run-harness.ts";
import { AgentRunner, type AgentRunnerEntry } from "../lib/agent-runner.ts";
import { normalizeApiUrl } from "../lib/api-url.ts";
import { cliText } from "../lib/cli-name.ts";
import { loadIdentity } from "../lib/identity.ts";
import { loadPieces } from "../lib/piece.ts";
import { absPath } from "../lib/utils.ts";

// `cf agent runner` — the per-user process that runs agent requests.
//
// A pattern's `agent()` request becomes an `AgentRun` record, listed in the
// requester's home-space agent queue. This process holds the requester's
// identity, sits beside their Loom instance, and pulls: it follows the queue
// on the toolshed serving the home space, follows each entry to its record on
// whichever toolshed serves the requesting space, runs `cf-harness` locally,
// and writes the result and the record's terminal fields back. Nothing on
// either toolshed connects to this process.

/** The Loom retrieval tools a runner offers when it has a Loom configuration. */
const LOOM_TOOLS = [
  "loom_search",
  "loom_page_discover",
  "loom_page_inspect",
  "loom_page_read",
  "loom_people",
  "loom_calendar_list",
  "loom_context",
  "loom_profile",
];

/** The harness tools every runner offers. */
const BASE_TOOLS = ["describe_handle", "web_fetch", "research"];

/** How long a claim's lease reaches past the run's last durable write. */
const DEFAULT_LEASE_SECONDS = 300;

/** Options the `cf agent runner` action receives (cliffy-parsed flags + env). */
export interface AgentRunnerCommandOptions {
  identity?: string;
  apiUrl?: string;
  localApiUrl?: string;
  loomRetrievalConfig?: string;
  maxConcurrent: number;
  tools?: string;
  workRoot?: string;
  leaseSeconds: number;
  model?: string;
}

/** The tool names a runner offers: `--tools`, or what its configuration backs. */
export function resolveRunnerTools(
  options: Pick<AgentRunnerCommandOptions, "tools" | "loomRetrievalConfig">,
): string[] {
  if (options.tools !== undefined) {
    return options.tools.split(",").map((tool) => tool.trim()).filter((tool) =>
      tool !== ""
    );
  }
  return options.loomRetrievalConfig !== undefined
    ? [...LOOM_TOOLS, ...BASE_TOOLS]
    : [...BASE_TOOLS];
}

/** Runs until the process receives SIGINT or SIGTERM. */
export async function agentRunnerAction(
  options: AgentRunnerCommandOptions,
): Promise<void> {
  if (!options.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  if (!options.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }
  if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new ValidationError(`"--max-concurrent" takes a whole number ≥ 1.`, {
      exitCode: 1,
    });
  }
  const identityPath = absPath(options.identity);
  const identity = await loadIdentity(identityPath);
  const home = identity.did();
  const homeHost = new URL(normalizeApiUrl(options.apiUrl)).origin;
  const runnerHost = options.localApiUrl !== undefined
    ? new URL(normalizeApiUrl(options.localApiUrl)).origin
    : homeHost;
  const tools = resolveRunnerTools(options);
  const workRoot = absPath(
    options.workRoot ??
      join(
        Deno.env.get("CF_HARNESS_HOME") ??
          join(Deno.env.get("HOME") ?? ".", ".cf-harness"),
        "agent-runs",
      ),
  );
  const report = (message: string) => console.error(message);

  // The home toolshed's connection is a full one: the home default pattern
  // runs here, since the queue's `agentRunner` entry takes writes only
  // through the pattern's own handler.
  const homePieces = await loadPieces({
    apiUrl: homeHost,
    space: home,
    identity: identityPath,
  });
  const runtimes = new Map<string, Runtime>([[homeHost, homePieces.runtime]]);
  const runtimeForHost = async (host: string): Promise<Runtime> => {
    const origin = new URL(host).origin;
    let runtime = runtimes.get(origin);
    if (runtime === undefined) {
      // A second toolshed gets a storage-only runtime: records are read and
      // written there, and nothing of that deployment's is run.
      runtime = new Runtime(runtimePresets.remoteClient({
        apiUrl: new URL(origin),
        storageManager: StorageManager.open({
          as: identity,
          memoryHost: new URL(origin),
        }),
        experimental: await experimentalOptionsForDeployedClient({
          apiUrl: new URL(origin),
          env: Deno.env.get,
        }),
      }));
      runtimes.set(origin, runtime);
    }
    return runtime;
  };

  const homePattern = await homePieces.ensureDefaultPattern();
  const queue = agentQueueIndexCell(homePieces.runtime, home);
  await queue.sync();
  if (queue.get() === undefined) {
    throw new Error(
      "The home space holds no agent queue: its home pattern predates the " +
        "`agentQueue` field. Open the home space in the shell once so the " +
        "pattern updates, then start the runner again.",
    );
  }
  const registerRunner = (entry: AgentRunnerEntry): Promise<void> => {
    // The controller's cell is bound to the transaction it was read under;
    // an event is sent from an unbound one. The send settles when the
    // handling's commit does.
    // deno-lint-ignore no-explicit-any
    const stream = (homePattern.getCell() as any).withTx()
      .key("agentQueue").key("setAgentRunner");
    return new Promise<void>((resolve) =>
      stream.send({ runner: entry }, () => resolve())
    );
  };

  const runner = new AgentRunner({
    homeSpace: home,
    homeHost,
    runnerHost,
    runnerId: `${home}#${crypto.randomUUID()}`,
    tools,
    maxConcurrent: options.maxConcurrent,
    leaseMs: options.leaseSeconds * 1000,
    runtimeForHost,
    registerRunner,
    execute: createHarnessAgentRunExecutor({
      identityKeyPath: identityPath,
      requester: home,
      workRoot,
      ...(options.loomRetrievalConfig !== undefined
        ? { loomRetrievalConfigPath: absPath(options.loomRetrievalConfig) }
        : {}),
      ...(options.model !== undefined
        ? { harnessArgs: ["--model", options.model] }
        : {}),
      report,
    }),
    report,
  });
  await runner.start();
  report(
    `agent runner: following ${home} on ${homeHost}, offering ${
      tools.join(", ")
    }`,
  );

  const stopped = Promise.withResolvers<void>();
  const onSignal = () => stopped.resolve();
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);
  await stopped.promise;
  Deno.removeSignalListener("SIGINT", onSignal);
  Deno.removeSignalListener("SIGTERM", onSignal);
  report("agent runner: stopping");
  await runner.stop();
  for (const runtime of runtimes.values()) {
    await runtime.dispose();
  }
}

const runnerDescription = cliText(
  `Run agent requests for one user, beside their Loom instance.

A pattern's agent() request becomes an AgentRun record listed in the
requester's home-space agent queue (wish '#agent_queue'). This process holds
the requester's identity and pulls: it registers itself as the queue's
agentRunner, claims the oldest queued record under --max-concurrent, runs
cf-harness locally, and writes the result and the record's terminal state
back. A record whose runner stopped writing is queued again once, then failed
as RUNNER_LOST. It runs until interrupted.

--api-url names the toolshed serving the home space. --local-api-url names the
toolshed this runner sits beside, when that is a different one; it is what the
agentRunner entry records as the runner's host. Records are read from whichever
toolshed their queue entry names.

The model provider is the one 'cf-harness' is configured with under
CF_HARNESS_HOME.`,
);

const runnerCommand = new Command()
  .name("runner")
  .description(runnerDescription)
  .env(
    "CF_API_URL=<url:string>",
    "URL of the toolshed serving the home space.",
    {
      prefix: "CF_",
    },
  )
  .option(
    "-a,--api-url <url:string>",
    "URL of the toolshed serving the home space.",
  )
  .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .option("-i,--identity <path:string>", "Path to an identity keyfile.")
  .option(
    "--local-api-url <url:string>",
    "URL of the toolshed this runner sits beside. Defaults to --api-url.",
  )
  .option(
    "--loom-retrieval-config <path:string>",
    "Host-owned JSON file backing the read-only Loom tools.",
  )
  .option(
    "--max-concurrent <n:integer>",
    "How many runs this process holds at once.",
    { default: 1 },
  )
  .option(
    "--tools <names:string>",
    "Comma-separated tool names this runner offers. Defaults to what its " +
      "configuration backs.",
  )
  .option(
    "--work-root <path:string>",
    "Directory for run workspaces and artifacts. Defaults to " +
      "$CF_HARNESS_HOME/agent-runs.",
  )
  .option(
    "--lease-seconds <n:integer>",
    "How far a claim's lease reaches past the run's last durable write.",
    { default: DEFAULT_LEASE_SECONDS },
  )
  .option("--model <name:string>", "Model name passed to cf-harness.")
  .action((options) => agentRunnerAction(options));

export const agent = new Command()
  .name("agent")
  .description("Run and inspect agent requests.")
  .default("help")
  .command("runner", runnerCommand);
