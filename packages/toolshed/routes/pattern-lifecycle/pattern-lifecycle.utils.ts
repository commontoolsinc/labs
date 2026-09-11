// The pattern-lifecycle verbs behind the route: authorize the caller as a
// writer of the space, hand the verb to the space's serving runtime, and
// turn what comes back into a status and a body. Everything that touches
// the space runs inside `@commonfabric/piece`'s served operations on the
// serving loop's own cycle (docs/features/server-pattern-lifecycle.md);
// this module holds the transport's half and is tested against a real
// memory server and serving host.

import { createSession, type Identity } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import {
  confirmServedInstantiate,
  PiecesController,
  servedInstantiatePiece,
  type ServedInstantiateReceipt,
  ServedLifecycleRefusal,
  type ServedLifecycleRefusalCode,
  type ServedPatternRef,
  type ServedPatternSource,
  servedUploadPattern,
} from "@commonfabric/piece/ops";
import type { Runtime, RuntimeProgram } from "@commonfabric/runner";
import {
  type ExecutorHost,
  type LifecycleVerb,
  SpaceNotServedError,
} from "@commonfabric/runner/executor/host";
import {
  authorizeSpaceWriter,
  type SpaceAuthorityDeps,
} from "@/lib/space-authority.ts";

export interface LifecycleDeps {
  /** What the writer check reads the space's ACL through. */
  authority: SpaceAuthorityDeps;

  /**
   * The serving loop's host; `undefined` on a deployment running without
   * it, which answers every verb 503.
   */
  host: () => ExecutorHost | undefined;

  /**
   * The identity the serving runtime's piece controller opens the space
   * as — the serving side's own, since the verb runs as the loop's
   * bookkeeping under the lease.
   */
  serviceIdentity: Identity;

  logger?: {
    warn: (obj: unknown, msg: string) => void;
    info: (obj: unknown, msg: string) => void;
  };
}

/** A refusal's stable name on the wire. */
export type LifecycleErrorCode =
  | ServedLifecycleRefusalCode
  | "invalid-source"
  | "forbidden"
  | "server-execution-off"
  | "space-not-served"
  | "internal";

/** What a verb returns: its receipt on 200, or a refusal with its code. */
export type LifecycleResult<T> =
  | { status: 200; body: T }
  | {
    status: 400 | 403 | 404 | 409 | 422 | 500 | 503;
    body: { error: string; code: LifecycleErrorCode };
  };

/** A request's pattern source as the wire carries it: one of the two. */
export interface WireSource {
  program?: RuntimeProgram;
  pattern?: ServedPatternRef;
}

const refuse = (
  status: Exclude<LifecycleResult<never>["status"], 200>,
  code: LifecycleErrorCode,
  error: string,
): LifecycleResult<never> => ({ status, body: { error, code } });

const REFUSAL_STATUS: Record<
  ServedLifecycleRefusalCode,
  403 | 404 | 409 | 422
> = {
  "compile-failed": 422,
  "pattern-not-found": 404,
  "setup-failed": 422,
  "slug-taken": 409,
  "no-space-root": 422,
};

/** The document a piece id names — the root the serving loop demands. */
function pieceRootDocId(pieceId: string): string {
  return pieceId.startsWith("of:") ? pieceId : `of:${pieceId}`;
}

function wireSource(source: WireSource): ServedPatternSource | undefined {
  if (source.program !== undefined && source.pattern === undefined) {
    return { program: source.program };
  }
  if (source.pattern !== undefined && source.program === undefined) {
    return { pattern: source.pattern };
  }
  return undefined;
}

/**
 * Authorize the caller and run one verb on the space's serving runtime.
 * `run` receives a piece controller over that runtime; `confirm` is the
 * verb's durability read, which the loop runs after the wave commit.
 */
async function runServedVerb<T>(
  deps: LifecycleDeps,
  callerDid: string,
  space: string,
  verb: {
    name: string;
    run: (pieces: PiecesController) => Promise<T>;
    confirm: LifecycleVerb<T>["confirm"];
    demandRoots?: LifecycleVerb<T>["demandRoots"];
  },
): Promise<LifecycleResult<T>> {
  const host = deps.host();
  if (host === undefined) {
    return refuse(
      503,
      "server-execution-off",
      "This deployment does not run the serving loop, so pattern-lifecycle " +
        "verbs cannot run on it (EXPERIMENTAL_SERVER_EXECUTION).",
    );
  }
  const authority = await authorizeSpaceWriter(
    deps.authority,
    space,
    callerDid,
  );
  if (!authority.ok) {
    deps.logger?.warn(
      { space, caller: callerDid, detail: authority.logDetail },
      "pattern-lifecycle verb refused",
    );
    return refuse(403, "forbidden", authority.message);
  }
  const session = await createSession({
    identity: deps.serviceIdentity,
    spaceDid: space as DID,
  });
  try {
    const receipt = await host.runLifecycleVerb<T>(space as MemorySpace, {
      name: verb.name,
      run: (runtime: Runtime) =>
        verb.run(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
        ),
      ...(verb.confirm === undefined ? {} : { confirm: verb.confirm }),
      ...(verb.demandRoots === undefined
        ? {}
        : { demandRoots: verb.demandRoots }),
    });
    return { status: 200, body: receipt };
  } catch (error) {
    if (error instanceof ServedLifecycleRefusal) {
      return refuse(REFUSAL_STATUS[error.code], error.code, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SpaceNotServedError) {
      return refuse(503, "space-not-served", message);
    }
    deps.logger?.warn(
      { space, verb: verb.name, error: message },
      "pattern-lifecycle verb failed",
    );
    return refuse(500, "internal", `${verb.name} failed: ${message}`);
  }
}

/** The `upload` verb: compile `program` into the space it names. */
export function processUpload(
  deps: LifecycleDeps,
  callerDid: string,
  input: { space: string; program: RuntimeProgram },
): Promise<LifecycleResult<{ pattern: ServedPatternRef }>> {
  return runServedVerb(deps, callerDid, input.space, {
    name: "upload",
    run: async (pieces) => ({
      pattern: (await servedUploadPattern(pieces, input.program)).ref,
    }),
    confirm: undefined,
  });
}

/**
 * The `instantiate` verb: create a piece from the request's pattern, named
 * and registered as asked, and name its root as the loop's demand so the
 * cycle after the creation's commit derives it.
 */
export function processInstantiate(
  deps: LifecycleDeps,
  callerDid: string,
  input: WireSource & {
    space: string;
    argument?: Record<string, unknown>;
    repository?: string;
    slug?: string;
    force?: boolean;
    register?: boolean;
  },
): Promise<LifecycleResult<ServedInstantiateReceipt>> {
  const source = wireSource(input);
  if (source === undefined) {
    return Promise.resolve(refuse(
      400,
      "invalid-source",
      "Supply exactly one of `program` and `pattern`.",
    ));
  }
  return runServedVerb(deps, callerDid, input.space, {
    name: "instantiate",
    run: (pieces) =>
      servedInstantiatePiece(pieces, {
        source,
        ...(input.argument === undefined ? {} : { argument: input.argument }),
        ...(input.repository === undefined
          ? {}
          : { repository: input.repository }),
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.force === undefined ? {} : { force: input.force }),
        ...(input.register === undefined ? {} : { register: input.register }),
        actingUser: callerDid,
      }),
    confirm: (runtime, receipt) =>
      confirmServedInstantiate(runtime, input.space as MemorySpace, receipt),
    demandRoots: (receipt) => [pieceRootDocId(receipt.pieceId)],
  });
}
