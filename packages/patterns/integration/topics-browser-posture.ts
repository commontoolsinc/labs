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
 * Reading a deployment has three outcomes, and no path labels a run from an
 * assumption. Where both halves are stated and agree, the posture is that
 * mode, carrying which statement the shell's half came from. Where both are
 * stated and disagree, reading refuses: a client and a server on opposite
 * postures exercise neither. Where the deployment states the shell's half
 * nowhere, the posture is `undeclared` — a recorded fact about the deployment
 * rather than a guess at what its shell runs, and never the first-party
 * default, which is a constant compiled into this process rather than
 * something the deployment said.
 *
 * Whether `undeclared` is acceptable belongs to the caller, because it is a
 * property of what a measurement is for. A benchmark comparing two postures
 * needs a declared one and reads through
 * {@link readDeclaredTopicsBrowserPosture}, which refuses the rest. A test
 * exercising the measurement helpers does not care what posture it ran under,
 * reads through {@link readTopicsBrowserPosture}, and carries whatever it
 * finds into its samples. A shell built without posture defines declares
 * nothing and is not thereby misconfigured.
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

/** A deployment whose two halves both state a posture, and agree on it. */
export interface DeclaredTopicsBrowserPosture {
  /** That the deployment states the posture its shell runs. */
  readonly declared: true;

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
 * A deployment that states nowhere what posture its shell runs. The toolshed
 * still reports what it serves at; nothing reports what the page ran, so this
 * carries no mode and a sample taken under it is not a measurement of either
 * posture.
 */
export interface UndeclaredTopicsBrowserPosture {
  /** That the deployment states nothing about the posture its shell runs. */
  readonly declared: false;

  /** Whether the toolshed reports serving with server execution on. */
  readonly served: boolean;

  /** What was read, and why neither statement settled the shell's half. */
  readonly reason: string;
}

/** What reading a deployment's posture came to. */
export type TopicsBrowserPosture =
  | DeclaredTopicsBrowserPosture
  | UndeclaredTopicsBrowserPosture;

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
 * Returns what `meta` and the served shell's `bundle` say about the posture
 * the deployment runs: the mode where both halves state one and agree, and an
 * undeclared posture where the shell's half is stated nowhere.
 *
 * It settles the shell's half from the first of these that states it: the
 * `shellServerExecutionDefine` the toolshed reports, and the define baked into
 * a bundle that was read. A shell built without posture defines states
 * neither, which is an ordinary configuration rather than a fault.
 *
 * @throws Error when the toolshed reports no resolved `serverExecution`, when
 * a statement of the posture is not a boolean spelling, or when the two halves
 * disagree.
 */
export function topicsBrowserPostureOf(
  meta: PostureMeta,
  bundle: ServedBundle = { kind: "unreachable", reason: "none was fetched" },
): TopicsBrowserPosture {
  const served = meta.experimental?.serverExecution;
  if (typeof served !== "boolean") {
    throw new Error(
      "The toolshed reports no resolved `serverExecution`, so it says " +
        `nothing about the posture it serves at: ${JSON.stringify(served)}`,
    );
  }
  const stated = clientPosture(meta, bundle);
  if (stated === undefined) {
    return {
      declared: false,
      served,
      reason: bundle.kind === "unreachable"
        ? `the toolshed names no baked define and no served shell could be ` +
          `read (${bundle.reason})`
        : "the toolshed names no baked define and the served shell's entry " +
          "script carries none either",
    };
  }
  const { client, clientFrom } = stated;
  if (client !== served) {
    throw new Error(
      `The toolshed serves \`serverExecution=${served}\` while the shell it ` +
        `serves runs \`${client}\` (read from the ${clientFrom}). A client ` +
        "and a server on opposite postures exercise neither, so the run has " +
        "no mode to be labeled with.",
    );
  }
  return {
    declared: true,
    mode: served ? "server-execution-on" : "server-execution-off",
    served,
    client,
    clientFrom,
  };
}

/**
 * Helper for {@link topicsBrowserPostureOf}, which returns the posture the
 * served shell runs and the statement it was read from, or `undefined` where
 * neither statement names one.
 *
 * @throws Error when a statement it reads is neither `true` nor `false`.
 */
function clientPosture(
  meta: PostureMeta,
  bundle: ServedBundle,
): { client: boolean; clientFrom: ClientPostureSource } | undefined {
  const declared = meta.shellServerExecutionDefine;
  if (declared !== undefined && declared !== null) {
    return { client: booleanNamed(declared, "meta"), clientFrom: "meta" };
  }
  if (bundle.kind === "unreachable") return undefined;
  const baked = BAKED_DEFINE.exec(bundle.source);
  if (baked === null) return undefined;
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
 * Returns what the deployment at `apiUrl`, serving the shell at
 * `frontendUrl`, says about the posture it runs, by reading `/api/meta` and,
 * where that names no baked define, the served shell's entry script. A
 * deployment that states its shell's posture in neither place reads as
 * undeclared; a caller that needs a declared one uses
 * {@link readDeclaredTopicsBrowserPosture} instead.
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

/**
 * Returns the posture the deployment at `apiUrl`, serving the shell at
 * `frontendUrl`, declares, for a measurement that compares postures and so
 * cannot proceed without knowing which one it is taking. `purpose` names that
 * measurement in the refusal.
 *
 * @throws Error as {@link readTopicsBrowserPosture} does, and when the
 * deployment declares no posture.
 */
export async function readDeclaredTopicsBrowserPosture(
  apiUrl: string | URL,
  frontendUrl: string | URL,
  purpose: string,
): Promise<DeclaredTopicsBrowserPosture> {
  const posture = await readTopicsBrowserPosture(apiUrl, frontendUrl);
  if (!posture.declared) {
    throw new Error(
      `${purpose} compares server-execution postures, so it needs a ` +
        "deployment that declares which one it runs, and this one does not: " +
        `${posture.reason}. Build the shell with ` +
        "`EXPERIMENTAL_SERVER_EXECUTION` set to the posture being measured.",
    );
  }
  return posture;
}
