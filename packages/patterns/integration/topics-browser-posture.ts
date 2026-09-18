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
 *
 * No path labels a run from an assumption. Where the deployment states the
 * shell's posture neither on `/api/meta` nor in the bundle it serves, the run
 * is refused rather than labeled from the first-party default, which is a
 * constant compiled into this process and not something the deployment said.
 * Refusing costs nothing a benchmark needs: with no shell to read there is no
 * shell to drive either. Every posture still carries
 * {@link TopicsBrowserPosture.clientFrom}, which a sample prints, so a reader
 * sees which of the two statements a label came from.
 */

/** Names the posture a browser-tier sample was taken under. */
export type TopicsBrowserMode =
  | "server-execution-on"
  | "server-execution-off";

/** Where the served shell's posture was read from. */
export type ClientPostureSource =
  /** `shellServerExecutionDefine`, which the toolshed reports of its shell. */
  | "meta"
  /** The build define baked into the served shell's bundle. */
  | "bundle";

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

/**
 * What `/api/meta` says about a deployment's posture. Both fields arrive as
 * JSON from a server this process does not control, so each is `unknown` and
 * checked rather than trusted, and each may arrive as `null`.
 */
export interface PostureMeta {
  /** The flags the deployment serves at, as it resolved them. */
  readonly experimental?: { readonly serverExecution?: unknown };

  /**
   * The raw `EXPERIMENTAL_SERVER_EXECUTION` the shell this toolshed serves
   * baked as its build define. `null` covers four situations the field does
   * not tell apart: the value was unset at build time and the shell follows
   * the first-party default, the toolshed runs from source and serves no
   * built shell, and the build marker was unreadable or malformed — the last
   * two being the failure posture `readBuildInfoFrom` gives the whole marker.
   */
  readonly shellServerExecutionDefine?: unknown;
}

/** The served shell's entry script, or why it was not read. */
export type ServedBundle =
  /** The script's text, as fetched from the shell being served. */
  | { readonly kind: "read"; readonly source: string }
  /** No script could be read, with what the attempt came to. */
  | { readonly kind: "unreachable"; readonly reason: string };

/**
 * Matches the build define in a served shell's bundle. The bundler emits the
 * define as the live arm of a conditional on its own presence, so the baked
 * value is the quoted string in that arm.
 */
const BAKED_DEFINE =
  /EXPERIMENTAL_SERVER_EXECUTION_DEFINE\s*=\s*true\s*\?\s*"([^"]*)"/;

/**
 * Returns the posture `meta` and the served shell's `bundle` agree on.
 *
 * It settles the shell's half from the first of these that states it: the
 * `shellServerExecutionDefine` the toolshed reports, and the define baked into
 * a bundle that was read.
 *
 * @throws Error when the toolshed reports no resolved `serverExecution`, when
 * a statement of the posture is not a boolean spelling, when neither statement
 * is available — a bundle read that carries no define, or no bundle to read —
 * or when the two halves disagree.
 */
export function topicsBrowserPostureOf(
  meta: PostureMeta,
  bundle: ServedBundle = { kind: "unreachable", reason: "none was fetched" },
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
 * @throws Error when a statement it reads is neither `true` nor `false`, and
 * when `bundle` was read and names no define.
 */
function clientPosture(
  meta: PostureMeta,
  bundle: ServedBundle,
): { client: boolean; clientFrom: ClientPostureSource } {
  const declared = meta.shellServerExecutionDefine;
  if (declared !== undefined && declared !== null) {
    return { client: booleanNamed(declared, "meta"), clientFrom: "meta" };
  }
  if (bundle.kind === "unreachable") {
    throw new Error(
      "The toolshed names no baked define and no served shell could be read " +
        `(${bundle.reason}), so nothing the deployment says states what ` +
        "posture its shell runs. Labeling that from the first-party default " +
        "would state a constant compiled into this process as though the " +
        "deployment had reported it, and a deployment serving no readable " +
        "shell has none to drive either.",
    );
  }
  const baked = BAKED_DEFINE.exec(bundle.source);
  if (baked === null) {
    throw new Error(
      "The served shell's entry script names no " +
        "`EXPERIMENTAL_SERVER_EXECUTION` build define, so what posture it " +
        "runs cannot be read from it. Build the shell at the posture the run " +
        "is measuring.",
    );
  }
  return { client: booleanNamed(baked[1], "bundle"), clientFrom: "bundle" };
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
 * baked define, the served shell's entry script. A deployment that states its
 * shell's posture in neither place is refused rather than assumed.
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
  const script = new URL("scripts/index.js", frontendUrl);
  const bundle = await fetch(script);
  return topicsBrowserPostureOf(
    meta,
    bundle.ok
      ? { kind: "read", source: await bundle.text() }
      : { kind: "unreachable", reason: `\`${script}\` gave ${bundle.status}` },
  );
}
