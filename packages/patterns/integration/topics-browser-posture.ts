/**
 * The server-execution posture a browser-tier Topics measurement ran under, so
 * that every sample says which mode produced it, as
 * `docs/plans/topics-computation-cost.md` asks of a run labeled by mode.
 *
 * The posture is read from the deployment under measurement rather than from
 * the environment the benchmark process was started with: a benchmark that
 * labeled its samples from its own `EXPERIMENTAL_SERVER_EXECUTION` would
 * label whatever it was told, including a deployment that resolved something
 * else. Two halves are read, and a run whose halves disagree is refused rather
 * than labeled, because a client and a server on opposite postures exercise
 * neither of them.
 *
 * Neither half is the worker's own report. The runtime client's protocol
 * carries no request that reads a worker's resolved flags back, so the closest
 * available statement of what the page ran is the shell it was served: the
 * shell declares its posture from the build define, and the worker refuses to
 * initialize when its resolved posture disagrees with that declaration, so a
 * page that loaded at all ran the posture its shell declared.
 */

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

/** Names the posture a browser-tier sample was taken under. */
export type TopicsBrowserMode =
  | "server-execution-on"
  | "server-execution-off";

/** Where the served shell's posture was read from. */
export type ClientPostureSource =
  /** `shellServerExecutionDefine`, which the toolshed reports of its shell. */
  | "meta"
  /** The build define baked into the served shell's bundle. */
  | "bundle"
  /** The first-party default, which an unset define leaves the shell on. */
  | "default";

/** The posture a browser-tier Topics measurement ran under. */
export interface TopicsBrowserPosture {
  /** The mode both halves agree on, which labels every sample of the run. */
  readonly mode: TopicsBrowserMode;

  /** Whether the toolshed reports serving with server execution on. */
  readonly served: boolean;

  /** Whether the shell the toolshed serves resolved server execution on. */
  readonly client: boolean;

  /** Which statement of the shell's posture `client` was read from. */
  readonly clientFrom: ClientPostureSource;
}

/** What `/api/meta` says about a deployment's posture. */
export interface PostureMeta {
  /** The flags the deployment serves at, as it resolved them. */
  readonly experimental?: { readonly serverExecution?: unknown };

  /**
   * The raw `EXPERIMENTAL_SERVER_EXECUTION` baked into the shell this toolshed
   * serves, or `null` where the shell carries no define — a source-run
   * toolshed, which serves no built shell, reports `null` as well.
   */
  readonly shellServerExecutionDefine?: unknown;
}

/**
 * Matches the build define in a served shell's bundle. The bundler emits the
 * define as the live arm of a conditional on its own presence, so the baked
 * value is the quoted string in that arm.
 */
const BAKED_DEFINE =
  /EXPERIMENTAL_SERVER_EXECUTION_DEFINE\s*=\s*true\s*\?\s*"([^"]*)"/;

/**
 * Returns the posture `meta` and the served shell's `bundle` agree on, with
 * `bundle` the text of the shell's entry script, or `undefined` where it was
 * not read.
 *
 * It settles the shell's half from the first of these that states it: the
 * `shellServerExecutionDefine` the toolshed reports, the define baked into
 * `bundle`, and the first-party default, which is what an unset define leaves
 * the shell on.
 *
 * @throws Error when the toolshed reports no resolved `serverExecution`, when
 * either statement of the posture is not a boolean spelling, or when the two
 * halves disagree.
 */
export function topicsBrowserPostureOf(
  meta: PostureMeta,
  bundle?: string,
): TopicsBrowserPosture {
  const served = meta.experimental?.serverExecution;
  if (typeof served !== "boolean") {
    throw new Error(
      "The toolshed reports no resolved `serverExecution`, so there is no " +
        `posture to label a sample with: ${JSON.stringify(served)}`,
    );
  }
  const { client, clientFrom } = clientPosture(meta, bundle);
  if (client !== served) {
    throw new Error(
      `The toolshed serves \`serverExecution=${served}\` while the shell it ` +
        `serves runs \`${client}\` (read from the ${clientFrom}). A client ` +
        "and a server on opposite postures exercise neither, so the run has " +
        "no mode to be labeled with.",
    );
  }
  return {
    mode: served ? "server-execution-on" : "server-execution-off",
    served,
    client,
    clientFrom,
  };
}

/**
 * Helper for {@link topicsBrowserPostureOf}, which returns the posture the
 * served shell runs and the statement it was read from.
 *
 * @throws Error when a statement it reads is neither `true` nor `false`.
 */
function clientPosture(
  meta: PostureMeta,
  bundle?: string,
): { client: boolean; clientFrom: ClientPostureSource } {
  const declared = meta.shellServerExecutionDefine;
  if (declared !== undefined && declared !== null) {
    return { client: booleanNamed(declared, "meta"), clientFrom: "meta" };
  }
  const baked = bundle === undefined ? null : BAKED_DEFINE.exec(bundle);
  if (baked !== null) {
    return { client: booleanNamed(baked[1], "bundle"), clientFrom: "bundle" };
  }
  return {
    client: SERVER_EXECUTION_DEFAULT_ENABLED,
    clientFrom: "default",
  };
}

/**
 * Helper for {@link clientPosture}, which returns `value` as the boolean its
 * spelling names.
 *
 * @throws Error when it spells neither `true` nor `false`.
 */
function booleanNamed(value: unknown, from: ClientPostureSource): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    `The shell's posture from the ${from} spells neither \`true\` nor ` +
      `\`false\`: ${JSON.stringify(value)}`,
  );
}

/**
 * Returns the posture the deployment at `apiUrl`, serving the shell at
 * `frontendUrl`, is running, by reading `/api/meta` and, where that names no
 * baked define, the served shell's entry script.
 *
 * @throws Error when `/api/meta` cannot be read, and as
 * {@link topicsBrowserPostureOf} does.
 */
export async function readTopicsBrowserPosture(
  apiUrl: string | URL,
  frontendUrl: string | URL,
): Promise<TopicsBrowserPosture> {
  const response = await fetch(new URL("api/meta", apiUrl));
  if (!response.ok) {
    throw new Error(
      `Reading the deployment's posture from \`/api/meta\` failed with ` +
        `${response.status}.`,
    );
  }
  const meta: PostureMeta = await response.json();
  if (
    meta.shellServerExecutionDefine !== undefined &&
    meta.shellServerExecutionDefine !== null
  ) {
    return topicsBrowserPostureOf(meta);
  }
  const bundle = await fetch(new URL("scripts/index.js", frontendUrl));
  return topicsBrowserPostureOf(
    meta,
    bundle.ok ? await bundle.text() : undefined,
  );
}
