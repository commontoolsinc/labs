import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  type CellScope,
  type ClientCommit,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntitySnapshot,
  type ExecutionControlEvent,
  type GraphQuery,
  type GraphQueryResult,
  type GraphQueryTrigger,
  type HelloOkMessage,
  type ResponseMessage,
  type SchedulerActionSnapshotQuery,
  type SchedulerActionSnapshotResult,
  type SchedulerExecutionContextKey,
  type SchedulerSnapshotListResult,
  type SchedulerWritersForTargetsQuery,
  type SchedulerWritersForTargetsResult,
  type SessionOpenRequest,
  type SessionSync,
  type SqliteDbRef,
  type SqliteParamsWire,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceResult,
  type V2Error,
  type WatchSpec,
  type WireMemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  type AcceptedCommitEvent,
  type ExecutionLeaseHandle,
  type ForeignWakeEvent,
  parseClientMessage,
  type Server,
} from "@commonfabric/memory/v2/server";
import type { BranchName } from "@commonfabric/memory/v2";
import {
  type ActionTransactionRouter,
  type Options,
  type SessionFactory,
  StorageManager,
} from "./v2.ts";
import type {
  ReplicaClient,
  ReplicaReadOptions,
  ReplicaSession,
} from "./v2-replica-session.ts";
import {
  installHostConflictRetryBarrier,
} from "./v2-host-conflict-readiness.ts";
import {
  isPrimitiveCellLink,
  type NormalizedLink,
  parseLinkPrimitive,
} from "../link-types.ts";

export interface AcceptedCommitNotice {
  space: string;
  branch: BranchName;
  order: number;
  dataSeq: number;
  deliverySeq: number;
  originSessionId?: string;
  /** Host-derived comparison only. Lane identity (a contextKey including the
   * lane principal's DID) crosses the executor channels since C1.5a/C1.5b;
   * raw sponsor credentials and session tokens still do not (amendment A23).
   * Present only on lease-bound channels. */
  originMatchesExecutionSponsor?: boolean;
  revisions: {
    branch: BranchName;
    id: string;
    scope?: string;
    /** RESOLVED scope key of the written instance (memory C1.4b): lets the
     * re-keyed Worker replica attribute sync frames to lanes. Additive —
     * consumption lands with C1.5b. */
    scopeKey?: string;
    seq: number;
  }[];
  schedulerUpdateIds: number[];
  staleDemandedReaders: AcceptedCommitEvent["staleDemandedReaders"];
}

/**
 * C3.3a (C3A11's provider leg): the running-Worker foreign-wake notice —
 * a read-space commit (or window/scan closure) made this home space's
 * mirrored-foreign-read actions stale. `readSeq` lives in the READ
 * space's seq domain and is diagnostic only; the notice deliberately
 * carries NO revisions/schedulerUpdateIds (there is no home commit to
 * integrate) so it can never be mistaken for an accepted-commit wave.
 * Reader identities carry `ownerSpace` = the home space, matching the
 * stale-reader identity shape the Worker's wake consumption keys on.
 *
 * Pre-C3.4 posture (pinned): the Worker CANNOT read the foreign data —
 * `docKey` has no space dimension and no foreign point read exists — so
 * this notice only marks/schedules: the matched action re-runs against
 * its home replica, its foreign read keeps it unservable
 * (`foreign-read-space`), and the attempt settles canonically unserved —
 * clients fall back and re-run with their own foreign replicas. C3.4
 * adds the read-side mount + point reads; C3.5's vector basis then lets
 * the rerun settle served with a foreign component.
 */
export interface ForeignWakeNotice {
  space: string;
  branch: BranchName;
  readSpace: string;
  readSeq: number;
  origin: ForeignWakeEvent["origin"];
  staleForeignReaders: {
    branch: BranchName;
    ownerSpace: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
    executionContextKey: SchedulerExecutionContextKey;
  }[];
}

type ProviderPortMessage =
  | { type: "memory"; payload: string }
  | { type: "accepted-commit"; notice: AcceptedCommitNotice }
  | { type: "accepted-commit-barrier"; barrierId: number }
  | { type: "foreign-wake"; notice: ForeignWakeNotice }
  | { type: "close"; message?: string };

interface HostProviderChannelBaseOptions {
  server: Server;
  space: MemorySpace;
  branch?: BranchName;
  /** Defense in depth: reject any Worker transaction escaping shadow storage. */
  shadowWrites?: boolean;
}

interface UnleasedHostProviderChannelOptions {
  /** Host-owned grant creation. This callback and its credentials never cross
   *  the MessagePort into the Worker. */
  authorizeSessionOpen: MemoryClient.SessionOpenAuthFactory;
  /** Explicit browser/test-realm mode. Executor channels leave this false so
   *  only real client connections can originate connection-owned demand. */
  allowExecutionDemand?: boolean;
  executionLease?: never;
}

interface LeasedHostProviderChannelOptions {
  /** Exact host-only authority bound before the memory handshake. The handle
   * remains in this realm and is never encoded onto the MessagePort. */
  executionLease: ExecutionLeaseHandle;
  authorizeSessionOpen?: never;
  allowExecutionDemand?: never;
}

export type HostProviderChannelOptions =
  & HostProviderChannelBaseOptions
  & (UnleasedHostProviderChannelOptions | LeasedHostProviderChannelOptions);

export interface HostProviderChannel {
  /** Opaque endpoint transferred to the executor Worker. */
  readonly port: MessagePort;
  dispose(): Promise<void>;
}

const responseError = (
  requestId: string,
  name: string,
  message: string,
): ResponseMessage<never> => ({
  type: "response",
  requestId,
  error: { name, message },
});

const requestIdOf = (message: unknown): string =>
  typeof message === "object" && message !== null &&
    "requestId" in message &&
    typeof (message as { requestId?: unknown }).requestId === "string"
    ? (message as { requestId: string }).requestId
    : "host-provider";

const messageSpace = (message: ReturnType<typeof parseClientMessage>) =>
  message !== null && "space" in message ? message.space : undefined;

const hasExecutionClaimAssertion = (commit: ClientCommit): boolean => {
  const observation = commit.schedulerObservation;
  return typeof observation === "object" && observation !== null &&
    !Array.isArray(observation) &&
    typeof (observation as Record<string, unknown>)
        .executionClaimAssertion === "object";
};

const toAcceptedCommitNotice = (
  event: AcceptedCommitEvent,
  originMatchesExecutionSponsor?: boolean,
): AcceptedCommitNotice => ({
  space: event.space,
  branch: event.branch,
  order: event.order,
  dataSeq: event.dataSeq,
  deliverySeq: event.deliverySeq,
  ...(event.originSessionId !== undefined
    ? { originSessionId: event.originSessionId }
    : {}),
  ...(originMatchesExecutionSponsor !== undefined
    ? { originMatchesExecutionSponsor }
    : {}),
  revisions: event.revisions.map((revision) => ({
    branch: revision.branch,
    id: revision.id,
    ...(revision.scope !== undefined ? { scope: revision.scope } : {}),
    scopeKey: revision.scopeKey,
    seq: revision.seq,
  })),
  schedulerUpdateIds: [...event.schedulerUpdateIds],
  staleDemandedReaders: event.staleDemandedReaders.map((reader) => ({
    ...reader,
  })),
});

/**
 * Normalize every branch-bearing request onto the host-owned lane. Messages
 * without a branch surface (session lifecycle and SQLite v1) remain bound by
 * the exact space and authenticated connection.
 */
const pinBranch = (
  message: NonNullable<ReturnType<typeof parseClientMessage>>,
  branch: BranchName,
): NonNullable<ReturnType<typeof parseClientMessage>> => {
  switch (message.type) {
    case "transact":
      return {
        ...message,
        commit: { ...message.commit, branch },
      };
    case "graph.query":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "docs.read":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "scheduler.snapshot.list":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "scheduler.writer.list":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "session.watch.set":
    case "session.watch.add":
      return {
        ...message,
        watches: message.watches.map((watch) =>
          // The F3 `docs` kind carries its branch at the top level (no query to
          // stamp); graph/query watches stamp the branch into the query roots.
          watch.kind === "docs"
            ? { ...watch, branch }
            : { ...watch, query: { ...watch.query, branch } }
        ),
      };
    default:
      return message;
  }
};

/**
 * Create the host half of an executor provider. All memory frames still enter
 * through Server.connect/Connection.receive, preserving handshake ordering,
 * session ownership, ACL/CFC/conflict checks, and post-commit hooks. The host
 * Unleased compatibility channels overwrite session.open authorization with
 * their host-owned grant callback. Lease-bound executor channels instead bind
 * exact host authority before the handshake and never request a Worker grant.
 */
export function createHostProviderChannel(
  options: HostProviderChannelOptions,
): HostProviderChannel {
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const branch = options.branch ?? "";
  let authContext: MemoryClient.SessionOpenAuthContext | null = null;
  let disposed = false;
  let receiving = Promise.resolve();
  let unsubscribeAcceptedCommits = () => {};
  let unsubscribeForeignWakes = () => {};

  const connection = options.server.connect((message) => {
    if (disposed) return;
    if (message.type === "hello.ok") {
      const hello = message as HelloOkMessage;
      if (hello.sessionOpen !== undefined) {
        authContext = hello.sessionOpen;
      }
    }
    hostPort.postMessage(
      {
        type: "memory",
        payload: encodeMemoryBoundary(message),
      } satisfies ProviderPortMessage,
    );
  });
  if (options.executionLease !== undefined) {
    connection.bindExecutionLease(options.executionLease);
  }

  const closeHost = (message?: string) => {
    if (disposed) return;
    disposed = true;
    unsubscribeAcceptedCommits();
    unsubscribeForeignWakes();
    connection.close();
    try {
      hostPort.postMessage(
        {
          type: "close",
          ...(message !== undefined ? { message } : {}),
        } satisfies ProviderPortMessage,
      );
    } catch {
      // The Worker may already have closed its transferred endpoint.
    }
    hostPort.close();
  };

  const sendError = (requestId: string, error: V2Error) => {
    if (disposed) return;
    hostPort.postMessage(
      {
        type: "memory",
        payload: encodeMemoryBoundary(
          responseError(requestId, error.name, error.message),
        ),
      } satisfies ProviderPortMessage,
    );
  };

  const receive = async (payload: string): Promise<void> => {
    const parsed = parseClientMessage(payload);
    if (parsed === null) {
      // Let the canonical parser produce its normal InvalidMessageError.
      await connection.receive(payload);
      return;
    }
    const requestedSpace = messageSpace(parsed);
    if (requestedSpace !== undefined && requestedSpace !== options.space) {
      sendError(requestIdOf(parsed), {
        name: "AuthorizationError",
        message: `executor provider is bound to ${options.space}`,
      });
      return;
    }
    if (
      parsed.type === "session.execution.demand.set" &&
      options.allowExecutionDemand !== true
    ) {
      sendError(parsed.requestId, {
        name: "AuthorizationError",
        message: "executor providers cannot originate client execution demand",
      });
      return;
    }
    if (
      parsed.type === "session.execution.legacy-background.acquire" ||
      parsed.type === "session.execution.legacy-background.renew" ||
      parsed.type === "session.execution.legacy-background.release"
    ) {
      sendError(parsed.requestId, {
        name: "AuthorizationError",
        message:
          "executor providers cannot control legacy background execution",
      });
      return;
    }
    if (
      options.shadowWrites === true && parsed.type === "transact" &&
      !hasExecutionClaimAssertion(parsed.commit)
    ) {
      sendError(parsed.requestId, {
        name: "AuthorizationError",
        message:
          "shadow executor providers require an exact claimed action assertion",
      });
      return;
    }
    if (parsed.type === "session.open") {
      if (options.executionLease !== undefined) {
        await connection.receive(encodeMemoryBoundary(parsed));
        return;
      }
      if (authContext === null) {
        sendError(parsed.requestId, {
          name: "ProtocolError",
          message: "executor provider has no active session challenge",
        });
        return;
      }
      let auth: MemoryClient.SessionOpenAuth | undefined;
      try {
        auth = await options.authorizeSessionOpen(
          parsed.space,
          parsed.session,
          authContext,
        );
      } catch (error) {
        sendError(parsed.requestId, {
          name: "AuthorizationError",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (auth === undefined) {
        sendError(parsed.requestId, {
          name: "AuthorizationError",
          message: "executor provider host did not grant the session",
        });
        return;
      }
      const authenticated: SessionOpenRequest = {
        ...parsed,
        invocation: auth.invocation,
        authorization: auth
          .authorization as SessionOpenRequest["authorization"],
      };
      await connection.receive(encodeMemoryBoundary(authenticated));
      return;
    }
    await connection.receive(encodeMemoryBoundary(pinBranch(parsed, branch)));
  };

  hostPort.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<ProviderPortMessage>;
    if (message.type === "close") {
      closeHost();
      return;
    }
    if (
      message.type === "accepted-commit-barrier" &&
      Number.isSafeInteger(message.barrierId)
    ) {
      // Queue behind every earlier Worker-originated memory frame. Any commit
      // accepted while handling those frames publishes its notice before this
      // marker is posted back on the same ordered MessagePort.
      receiving = receiving.then(() => {
        if (disposed) return;
        hostPort.postMessage(
          {
            type: "accepted-commit-barrier",
            barrierId: message.barrierId!,
          } satisfies ProviderPortMessage,
        );
      }).catch((error) => {
        closeHost(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (message.type !== "memory" || typeof message.payload !== "string") {
      closeHost("invalid executor provider message");
      return;
    }
    receiving = receiving.then(
      () => receive(message.payload!),
      () => receive(message.payload!),
    ).catch((error) => {
      closeHost(error instanceof Error ? error.message : String(error));
    });
  });
  hostPort.addEventListener("messageerror", () => {
    closeHost("executor provider message decoding failed");
  });
  hostPort.start();

  // Register before returning the Worker endpoint. MessagePort queues notices
  // until its peer starts, which closes the initial point-read race without a
  // server graph watch.
  unsubscribeAcceptedCommits = options.server.subscribeAcceptedCommits(
    options.space,
    (event) => {
      if (disposed || event.branch !== branch) return;
      const originMatchesExecutionSponsor = options.executionLease ===
          undefined
        ? undefined
        : options.server.executionOriginMatchesLeaseSponsor(
          options.executionLease,
          event.originSessionId,
        );
      hostPort.postMessage(
        {
          type: "accepted-commit",
          notice: toAcceptedCommitNotice(
            event,
            originMatchesExecutionSponsor,
          ),
        } satisfies ProviderPortMessage,
      );
    },
  );
  // C3.3a (C3A11): the running-Worker leg — foreign wakes reach the live
  // Worker over the same ordered port. The server dispatches them only
  // after the corresponding foreign dirt applied to the home engine, so
  // by the time the Worker reacts the staleness is durable host-side.
  unsubscribeForeignWakes = options.server.subscribeForeignWakes(
    options.space,
    (event) => {
      if (disposed || event.branch !== branch) return;
      hostPort.postMessage(
        {
          type: "foreign-wake",
          notice: {
            space: event.space,
            branch: event.branch,
            readSpace: event.readSpace,
            readSeq: event.readSeq,
            origin: event.origin,
            staleForeignReaders: event.staleForeignReaders.map((reader) => ({
              branch: reader.branch,
              // The wake's readers are HOME actions; stamp the owner so
              // the Worker-side identity key matches its registrations.
              ownerSpace: event.space,
              pieceId: reader.pieceId,
              processGeneration: reader.processGeneration,
              actionId: reader.actionId,
              executionContextKey: reader.executionContextKey,
            })),
          },
        } satisfies ProviderPortMessage,
      );
    },
  );

  return {
    port: channel.port2,
    dispose() {
      closeHost();
      // Connection.close detaches the authenticated session and suppresses any
      // late response. A read already executing inside the Server may still
      // unwind, but disposal must not wait for that non-cancellable work or a
      // terminated Worker could strand its host lease/channel indefinitely.
      void receiving.catch(() => undefined);
      return Promise.resolve();
    },
  };
}

class MessagePortTransport implements MemoryClient.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #closed = false;
  #acceptedCommitReceiver: ((notice: AcceptedCommitNotice) => void) | null =
    null;
  #bufferedAcceptedCommits: AcceptedCommitNotice[] = [];
  #foreignWakeReceiver: ((notice: ForeignWakeNotice) => void) | null = null;
  #bufferedForeignWakes: ForeignWakeNotice[] = [];
  #acceptedCommitBarrierId = 0;
  #acceptedCommitBarriers = new Map<number, PromiseWithResolvers<void>>();

  constructor(private readonly port: MessagePort) {
    port.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as Partial<ProviderPortMessage>;
      if (message.type === "memory" && typeof message.payload === "string") {
        this.#receiver(message.payload);
      } else if (
        message.type === "accepted-commit" && message.notice !== undefined
      ) {
        if (this.#acceptedCommitReceiver === null) {
          this.#bufferedAcceptedCommits.push(message.notice);
        } else {
          this.#acceptedCommitReceiver(message.notice);
        }
      } else if (
        message.type === "accepted-commit-barrier" &&
        Number.isSafeInteger(message.barrierId)
      ) {
        const pending = this.#acceptedCommitBarriers.get(message.barrierId!);
        if (pending === undefined) {
          this.closeFromHost("unknown executor provider commit barrier");
          return;
        }
        this.#acceptedCommitBarriers.delete(message.barrierId!);
        pending.resolve();
      } else if (
        message.type === "foreign-wake" && message.notice !== undefined
      ) {
        if (this.#foreignWakeReceiver === null) {
          this.#bufferedForeignWakes.push(message.notice);
        } else {
          this.#foreignWakeReceiver(message.notice);
        }
      } else if (message.type === "close") {
        this.closeFromHost(message.message);
      } else {
        this.closeFromHost("invalid host provider message");
      }
    });
    port.addEventListener("messageerror", () => {
      this.closeFromHost("host provider message decoding failed");
    });
    port.start();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  setAcceptedCommitReceiver(
    receiver: (notice: AcceptedCommitNotice) => void,
  ): void {
    this.#acceptedCommitReceiver = receiver;
    const buffered = this.#bufferedAcceptedCommits;
    this.#bufferedAcceptedCommits = [];
    for (const notice of buffered) receiver(notice);
  }

  /** C3.3a: the foreign-wake leg's receiver, buffered like accepted
   * commits so a wake posted before the replica wires up is not lost. */
  setForeignWakeReceiver(
    receiver: (notice: ForeignWakeNotice) => void,
  ): void {
    this.#foreignWakeReceiver = receiver;
    const buffered = this.#bufferedForeignWakes;
    this.#bufferedForeignWakes = [];
    for (const notice of buffered) receiver(notice);
  }

  acceptedCommitBarrier(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("executor provider transport closed"));
    }
    const barrierId = ++this.#acceptedCommitBarrierId;
    const pending = Promise.withResolvers<void>();
    this.#acceptedCommitBarriers.set(barrierId, pending);
    try {
      this.port.postMessage(
        {
          type: "accepted-commit-barrier",
          barrierId,
        } satisfies ProviderPortMessage,
      );
    } catch (error) {
      this.#acceptedCommitBarriers.delete(barrierId);
      pending.reject(error);
    }
    return pending.promise;
  }

  send(payload: string): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("executor provider transport closed"));
    }
    this.port.postMessage(
      { type: "memory", payload } satisfies ProviderPortMessage,
    );
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.rejectAcceptedCommitBarriers(
      new Error("executor provider transport closed"),
    );
    try {
      this.port.postMessage({ type: "close" } satisfies ProviderPortMessage);
    } finally {
      this.port.close();
    }
    return Promise.resolve();
  }

  private closeFromHost(message?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.port.close();
    const error = new Error(message ?? "executor provider host closed");
    this.rejectAcceptedCommitBarriers(error);
    this.#closeReceiver(error);
  }

  private rejectAcceptedCommitBarriers(error: Error): void {
    for (const pending of this.#acceptedCommitBarriers.values()) {
      pending.reject(error);
    }
    this.#acceptedCommitBarriers.clear();
  }
}

// Instance identity prefers the RESOLVED scope key (present on every
// C1.4b-and-later snapshot): two lanes' instances of one id must never
// collide in the tracked-entity maps or the before/after diff.
const snapshotKey = (snapshot: {
  branch: string;
  id: string;
  scope?: string;
  scopeKey?: string;
}): string =>
  `${snapshot.branch}\0${
    snapshot.scopeKey ?? snapshot.scope ?? "space"
  }\0${snapshot.id}`;

const declaredEntityKey = (snapshot: {
  id: string;
  scope?: string;
}): string => `${snapshot.scope ?? "space"}\0${snapshot.id}`;

/**
 * FA6 shared contract (Worker half): an accepted-commit notice revision
 * matches a tracked instance when their RESOLVED scope keys agree; the
 * declared-scope comparison is the fallback used only when either side
 * predates the C1.4b stamp (older host or older snapshot).
 */
export const acceptedRevisionMatchesSnapshot = (
  revision: { id: string; scope?: string; scopeKey?: string },
  snapshot: { id: string; scope?: string; scopeKey?: string },
): boolean =>
  revision.id === snapshot.id &&
  (revision.scopeKey !== undefined && snapshot.scopeKey !== undefined
    ? revision.scopeKey === snapshot.scopeKey
    : declaredEntityKey(revision) === declaredEntityKey(snapshot));

/**
 * Same-space link targets of one held document as declared entity keys — the
 * F2 topology detector. A steady wave must leave every held doc's outbound
 * link set unchanged relative to its owning watches; anything else
 * (growth/shrink) re-enters the cold traversal path. Declared keys suffice:
 * within one watch the whole graph resolved under one acting context, so a
 * declared address names exactly one instance there.
 */
const collectLinkTargetKeys = (
  document: EntityDocument | null,
  container: { id: string; scope?: CellScope },
  space: string,
): Set<string> => {
  const targets = new Set<string>();
  if (document === null) return targets;
  const base: NormalizedLink = {
    id: container.id as NormalizedLink["id"],
    space: space as NormalizedLink["space"],
    path: [],
    scope: container.scope ?? "space",
  };
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (isPrimitiveCellLink(value)) {
      const link = parseLinkPrimitive(value, base);
      if (
        link.id !== undefined && !link.id.startsWith("data:") &&
        (link.space === undefined || link.space === space)
      ) {
        // "inherit" resolved against the container's declared scope above.
        targets.add(`${link.scope ?? "space"}\0${link.id}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const key of Object.keys(value)) {
      visit((value as Record<string, unknown>)[key]);
    }
  };
  visit(document);
  return targets;
};

// C1.5b/FA6: the resolved scopeKey rides the session-sync upsert (and, since
// F2, the matching remove) so the re-keyed Worker replica can attribute the
// frame to its owning lane.
const syncUpsert = (snapshot: EntitySnapshot) => ({
  branch: snapshot.branch,
  id: snapshot.id,
  ...(snapshot.scope !== undefined ? { scope: snapshot.scope } : {}),
  ...(snapshot.scopeKey !== undefined ? { scopeKey: snapshot.scopeKey } : {}),
  seq: snapshot.seq,
  ...(snapshot.document === null
    ? { deleted: true as const }
    : { doc: snapshot.document }),
});

/**
 * Worker-side session facade. Authenticated operations still use the ordinary
 * memory session, while graph subscriptions are replaced by host-pushed
 * accepted-commit notices integrated through exact point reads (F2): a
 * steady-state wave — every revision names a held instance and no held doc's
 * link topology changes — runs zero graph traversals; registration pulls,
 * closure growth/shrink, unresolved roots, and resolution moves stay on the
 * cold graph-query path.
 */
class HostReplicaSession implements ReplicaSession {
  // The executor replica maintains graph/query watches only; the F3 `docs`
  // WatchSpec kind is the CLIENT closure-export surface (F4) and is never
  // registered here, so the map excludes it and the traversal sites below can
  // read `.query` without narrowing.
  #watches = new Map<string, Exclude<WatchSpec, { kind: "docs" }>>();
  /** Acting context each watch registered under (C1.4b/C1.5b): the provider
   * re-queries watches itself, so every refresh must RE-SEND the lane the
   * watch was registered with or a scoped root would silently re-resolve
   * under the sponsor. Absent for space-lane watches. */
  #watchActingContexts = new Map<string, SchedulerExecutionContextKey>();
  #watchEntities = new Map<string, Map<string, EntitySnapshot>>();
  #view: MemoryClient.WatchView | null = null;
  #mutation = Promise.resolve();
  #appliedSeq: number;
  #acceptedOrder = 0;
  #pendingAcceptedCommits: AcceptedCommitNotice[] = [];
  /** FB13 wave resilience: notices whose integration was blocked by a
   * rejected point-read group or a failed cold refresh (e.g. a drained
   * lane's `laneReadRejection`). They are NOT dropped with the spliced-out
   * batch: they retry on the next flush — a new accepted notice, or a
   * lane-drain prune that changes the grouping. Growth is bounded by the
   * write rate to the blocked docs during the outage, and the buffer drains
   * as soon as the failing group heals (retried notices that no longer match
   * anything integrate trivially). */
  #deferredAcceptedCommits: AcceptedCommitNotice[] = [];
  #acceptedCommitDeliveryScheduled = false;
  #schedulerDeliverySeq: number;
  #executionDeliverySeq: number;
  #pendingExecutionEvents: ExecutionControlEvent[] = [];
  #executionDeliveryScheduled = false;
  #pendingExecutionBatches: {
    fromFeedSeq: number;
    toFeedSeq: number;
    events: ExecutionControlEvent[];
  }[] = [];
  #unsubscribeExecutionControl = () => {};
  #seenObservationVersions = new Map<number, string>();
  #closed = false;
  readonly setExecutionDemand?: NonNullable<
    ReplicaSession["setExecutionDemand"]
  >;
  readonly subscribeExecutionControl?: NonNullable<
    ReplicaSession["subscribeExecutionControl"]
  >;

  constructor(
    private readonly session: MemoryClient.SpaceSession,
    private readonly transport: MessagePortTransport,
    private readonly branch: BranchName,
    private readonly supportsExecutionDemand: boolean,
    private readonly onAcceptedCommitWillIntegrate?: (
      notice: AcceptedCommitNotice,
    ) => void,
    private readonly onAcceptedCommitIntegrated?: (
      notice: AcceptedCommitNotice,
    ) => void,
    private readonly onForeignWake?: (notice: ForeignWakeNotice) => void,
  ) {
    this.#appliedSeq = session.serverSeq;
    this.#schedulerDeliverySeq = session.serverSeq;
    this.#executionDeliverySeq = session.executionFeedSeq;
    transport.setAcceptedCommitReceiver((notice) => {
      this.queueAcceptedCommit(notice);
    });
    // C3.3a (C3A11 provider leg): a foreign wake carries no home commit
    // to integrate — no point reads, no watermark movement, no wave. It
    // rides the SAME mutation chain as accepted-commit refreshes so its
    // observer never overtakes an in-flight home integration (the wake
    // consumption keys on action registrations the wave may be
    // creating). See ForeignWakeNotice for the pinned pre-C3.4 posture.
    transport.setForeignWakeReceiver((notice) => {
      if (this.#closed || this.onForeignWake === undefined) return;
      this.#mutation = this.#mutation.then(
        () => {
          if (this.#closed) return;
          try {
            this.onForeignWake?.(notice);
          } catch (error) {
            console.warn("executor foreign-wake observer failed", error);
          }
        },
        () => {},
      );
    });
    if (supportsExecutionDemand) {
      this.setExecutionDemand = (branch, pieces) =>
        this.session.setExecutionDemand?.(branch, pieces) ??
          Promise.resolve(false);
      this.subscribeExecutionControl = (listener) =>
        this.session.subscribeExecutionControl(listener);
      this.#unsubscribeExecutionControl = this.session
        .subscribeExecutionControl((event) => {
          this.queueExecutionControl(event);
        });
    }
  }

  /** Wait until every accepted-commit notice already delivered by the host has
   * refreshed the replica, then return the integrated data watermark. */
  acceptedCommitsSettled(): Promise<number> {
    return this.transport.acceptedCommitBarrier().then(() => this.#mutation)
      .then(() => this.#appliedSeq);
  }

  private queueAcceptedCommit(notice: AcceptedCommitNotice): void {
    if (this.#closed) return;
    this.#pendingAcceptedCommits.push(notice);
    this.scheduleAcceptedCommitDelivery();
  }

  private scheduleAcceptedCommitDelivery(includeDeferred = false): void {
    if (
      this.#closed || this.#acceptedCommitDeliveryScheduled ||
      (this.#pendingAcceptedCommits.length === 0 &&
        !(includeDeferred && this.#deferredAcceptedCommits.length > 0))
    ) return;
    this.#acceptedCommitDeliveryScheduled = true;
    const refresh = this.#mutation.then(
      () => this.flushAcceptedCommits(),
      () => this.flushAcceptedCommits(),
    );
    this.#mutation = refresh.catch((error) => {
      if (
        !(error instanceof Error) ||
        (!error.message.includes("memory session closed") &&
          !error.message.includes("memory client closed") &&
          !error.message.includes("memory client is closed") &&
          !error.message.includes("transport closed"))
      ) {
        console.warn("executor accepted-commit refresh failed", error);
      }
    });
  }

  private async flushAcceptedCommits(): Promise<void> {
    try {
      // Deferred notices are re-attempted at most ONCE per flush: a group
      // that fails again re-defers and waits for the next trigger (a new
      // notice or a lane prune) instead of spinning this loop hot.
      let deferredConsumed = false;
      while (
        this.#pendingAcceptedCommits.length > 0 ||
        (!deferredConsumed && this.#deferredAcceptedCommits.length > 0)
      ) {
        const deferred = deferredConsumed
          ? []
          : this.#deferredAcceptedCommits.splice(0);
        deferredConsumed = true;
        const batch = this.#pendingAcceptedCommits.splice(0);
        await this.refreshAndNotifyAcceptedCommits(batch, deferred);
      }
    } finally {
      this.#acceptedCommitDeliveryScheduled = false;
      this.scheduleAcceptedCommitDelivery();
    }
  }

  private async refreshAndNotifyAcceptedCommits(
    notices: readonly AcceptedCommitNotice[],
    deferred: readonly AcceptedCommitNotice[] = [],
  ): Promise<void> {
    const integrated = await this.refreshAcceptedCommits(notices, deferred);
    // Preserve one ordered control-plane callback per accepted commit. A
    // coalesced batch deliberately exposes its newest integrated replica state
    // to every callback instead of rematerializing transient intermediate
    // document states.
    for (const notice of integrated) {
      try {
        this.onAcceptedCommitIntegrated?.(notice);
      } catch (error) {
        // The replica is already integrated and the commit durable. A
        // selective wake observer is diagnostic/control-plane work and cannot
        // roll either fact back or poison later accepted notices.
        console.warn("executor accepted-commit observer failed", error);
      }
    }
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionToken(): string | undefined {
    return this.session.sessionToken;
  }

  get serverSeq(): number {
    return this.session.serverSeq;
  }

  get executionClaims() {
    return this.supportsExecutionDemand
      ? this.session.executionClaims
      : undefined;
  }

  get executionFeedSeq() {
    return this.supportsExecutionDemand
      ? this.session.executionFeedSeq
      : undefined;
  }

  async transact(commit: ClientCommit) {
    try {
      return await this.session.transact({ ...commit, branch: this.branch });
    } catch (error) {
      installHostConflictRetryBarrier(error, {
        acceptedCommitsSettled: () => this.acceptedCommitsSettled(),
        markCaughtUp: () => {
          this.#view?.applySync({
            type: "sync",
            fromSeq: this.#appliedSeq,
            toSeq: this.#appliedSeq,
            caughtUpLocalSeq: commit.localSeq,
            upserts: [],
            removes: [],
          }, true);
        },
      });
      throw error;
    }
  }

  noteAppliedCommit(seq: number): void {
    this.session.noteAppliedCommit(seq);
  }

  queryGraph(
    query: GraphQuery,
    options?: ReplicaReadOptions,
  ): Promise<GraphQueryResult> {
    return this.session.queryGraph({ ...query, branch: this.branch }, options);
  }

  sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult> {
    return this.session.sqliteQuery(db, sql, params);
  }

  registerSqliteDiskSource(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult> {
    return this.session.registerSqliteDiskSource(id, path);
  }

  async listSchedulerActionSnapshots(
    query: SchedulerActionSnapshotQuery = {},
    options?: ReplicaReadOptions,
  ): Promise<SchedulerSnapshotListResult> {
    const result = await this.session.listSchedulerActionSnapshots({
      ...query,
      branch: this.branch,
    }, options);
    for (const snapshot of result.snapshots) {
      this.#seenObservationVersions.set(
        snapshot.observationId,
        encodeMemoryBoundary(snapshot),
      );
      if (snapshot.commitSeq !== null) {
        this.#schedulerDeliverySeq = Math.max(
          this.#schedulerDeliverySeq,
          snapshot.commitSeq,
        );
      }
    }
    return result;
  }

  writersForTargets(
    query: SchedulerWritersForTargetsQuery,
    options?: ReplicaReadOptions,
  ): Promise<SchedulerWritersForTargetsResult> {
    return this.session.writersForTargets({
      ...query,
      branch: this.branch,
    }, options);
  }

  watchAddSync(watches: WatchSpec[], options?: ReplicaReadOptions): Promise<{
    view: MemoryClient.WatchView;
    sync: SessionSync;
  }> {
    let result!: { view: MemoryClient.WatchView; sync: SessionSync };
    this.#mutation = this.#mutation.then(async () => {
      if (this.#closed) throw new Error("executor provider session closed");
      for (const watch of watches) {
        // Defensive: the executor never issues doc-set watches, but the union
        // permits them — skip so the graph/query-only invariant above holds.
        if (watch.kind === "docs") continue;
        this.#watches.set(watch.id, watch);
        if (options?.actingContext !== undefined) {
          this.#watchActingContexts.set(watch.id, options.actingContext);
        } else {
          this.#watchActingContexts.delete(watch.id);
        }
      }
      const fromSeq = this.#appliedSeq;
      // Registration is the first-demand cold pull (FA5/FB12: demand bucket).
      await this.refreshWatches(
        watches.map((watch) => watch.id),
        undefined,
        "demand",
      );
      const sync = this.fullSync(fromSeq, this.#appliedSeq);
      if (this.#view === null) {
        this.#view = MemoryClient.WatchView.fromSync(sync);
      } else {
        this.#view.applySync(sync, false);
      }
      result = { view: this.#view, sync };
      if (this.#pendingExecutionBatches.length > 0) {
        const pending = this.#pendingExecutionBatches.splice(0);
        await this.deliverExecutionBatches(pending);
      }
    });
    return this.#mutation.then(() => result);
  }

  /**
   * C1.9/FB13 lane-drain watch lifecycle: called from the Worker's lane-drain
   * reconcile (executor-worker `applyLaneDemands` → `pruneExecutionLane`).
   * A drained lane's grant is gone server-side, so every read re-sending its
   * acting context is rejected forever; without this hook the dead watches
   * keep keying point-read groups and cold refreshes.
   *
   * - A watch whose every root is BROAD (space-declared) is RE-KEYED onto
   *   the context-free/sponsor read path: broad roots resolve identically
   *   under any lane, so the shared read keeps flowing ("a dead lane grant
   *   must not starve the shared read") and surviving lanes whose hydration
   *   dedup'd onto this watch's coverage stay served. Residual: the watch
   *   stays context-free after the lane returns (re-hydration is coverage-
   *   deduped) — for broad closures the maintained bytes are identical, and
   *   any scoped closure member degrades visibly through the FA6 mismatch →
   *   cold re-key path rather than silently.
   * - A watch with a SCOPED root is RETIRED: resolving it under the sponsor
   *   would address the wrong instance, and re-sending the dead lane rejects
   *   forever. The SpaceReplica clears the lane's scoped selector coverage in
   *   the same prune, so the lane's next hydration re-registers it cleanly.
   *
   * Deferred notices are re-attempted afterwards: the prune is exactly the
   * event that changes their grouping.
   */
  pruneLaneWatches(lane: SchedulerExecutionContextKey): void {
    if (lane === "space") return;
    const prune = () => this.pruneLaneWatchesNow(lane);
    this.#mutation = this.#mutation.then(prune, prune).then(() => {
      this.scheduleAcceptedCommitDelivery(true);
    });
  }

  private pruneLaneWatchesNow(lane: SchedulerExecutionContextKey): void {
    if (this.#closed) return;
    for (const [watchId, watch] of [...this.#watches]) {
      if (this.#watchActingContexts.get(watchId) !== lane) continue;
      const broadOnly = watch.query.roots.every((root) =>
        root.scope === undefined || root.scope === "space"
      );
      if (broadOnly) {
        this.#watchActingContexts.delete(watchId);
      } else {
        this.#watches.delete(watchId);
        this.#watchActingContexts.delete(watchId);
        this.#watchEntities.delete(watchId);
      }
    }
  }

  private async refreshAcceptedCommits(
    notices: readonly AcceptedCommitNotice[],
    deferred: readonly AcceptedCommitNotice[] = [],
  ): Promise<AcceptedCommitNotice[]> {
    if (this.#closed) return [];
    const accepted: AcceptedCommitNotice[] = [];
    // FB13 re-queue: deferred notices were accepted (and their order
    // watermark consumed) on an earlier flush whose point-read group failed —
    // they BYPASS the order filter, and their pre-integrate observer already
    // fired once.
    const deferredOrders = new Set<number>();
    for (const notice of deferred) {
      if (
        notice.space !== this.session.space || notice.branch !== this.branch
      ) continue;
      accepted.push(notice);
      deferredOrders.add(notice.order);
    }
    let acceptedOrder = this.#acceptedOrder;
    for (const notice of notices) {
      if (
        notice.space !== this.session.space || notice.branch !== this.branch ||
        notice.order <= acceptedOrder
      ) continue;
      accepted.push(notice);
      acceptedOrder = notice.order;
    }
    if (accepted.length === 0) return [];
    accepted.sort((left, right) => left.order - right.order);
    for (const notice of accepted) {
      if (deferredOrders.has(notice.order)) continue;
      try {
        this.onAcceptedCommitWillIntegrate?.(notice);
      } catch (error) {
        // Causal attribution is control-plane state. A failing observer must
        // not suppress integration of an already accepted durable commit.
        console.warn(
          "executor accepted-commit pre-integrate observer failed",
          error,
        );
      }
    }
    const fromSeq = this.#appliedSeq;
    const dataSeq = Math.max(...accepted.map((notice) => notice.dataSeq));
    const deliverySeq = Math.max(
      ...accepted.map((notice) => notice.deliverySeq),
    );
    let observations: SchedulerActionSnapshotResult[] = [];
    const schedulerUpdateIds = new Set(
      accepted.flatMap((notice) =>
        notice.originSessionId === this.sessionId
          ? []
          : notice.schedulerUpdateIds
      ),
    );
    if (schedulerUpdateIds.size > 0) {
      try {
        observations = await this.adoptionObservations(
          deliverySeq,
          schedulerUpdateIds,
        );
      } catch (error) {
        // Scheduler adoption is optional. Keep its cursor unchanged and still
        // deliver the required document invalidation for this accepted commit.
        console.warn("executor scheduler adoption failed", error);
      }
    }
    if (this.#watches.size === 0) {
      this.#acceptedOrder = acceptedOrder;
      this.#appliedSeq = Math.max(this.#appliedSeq, dataSeq);
      return accepted;
    }
    const revisions = accepted.flatMap((notice) => notice.revisions);
    // Watch roots carry only a DECLARED scope (resolution happens host-side
    // under the watch's acting context), so root dirtiness stays a
    // declared-scope comparison; tracked snapshots carry the resolved
    // scopeKey and match instances exactly (FA6).
    const declaredDirty = new Set(revisions.map(declaredEntityKey));

    // FA5 interest set: every instance this replica holds — the union of the
    // per-watch entity maps, instance-keyed by resolved scopeKey (the C1.5b
    // re-keying), where absent-but-tracked docs appear as null-document
    // snapshots. Point reads are issued ONLY for these entries, so every
    // delivery has a registered watch behind it (no W2.8
    // reads-without-a-delivery-source class).
    // Cold watches carry their FA5/FB12 trigger cause: "demand" for new data
    // entering (first-pull retry, closure growth), "wave" for a refresh the
    // wave itself forces (shrink, root re-establishment, resolution moves).
    // "wave" wins when one wave produces both causes for a watch — the F2
    // floor signal must not be hidden under a coincident growth.
    const coldWatches = new Map<string, GraphQueryTrigger>();
    const markCold = (watchId: string, trigger: GraphQueryTrigger) => {
      if (trigger === "wave" || !coldWatches.has(watchId)) {
        coldWatches.set(watchId, trigger);
      }
    };
    interface PointReadTask {
      address: { id: string; scope?: CellScope };
      actingContext?: SchedulerExecutionContextKey;
      expected: EntitySnapshot;
      watchIds: string[];
    }
    const pointTasks = new Map<string, PointReadTask>();
    for (const [watchId, watch] of this.#watches) {
      const held = this.#watchEntities.get(watchId);
      const rootDirty = (root: { id: string; scope?: CellScope }) =>
        declaredDirty.has(declaredEntityKey(root));
      if (held === undefined) {
        // Registration never completed a pull; a named root is a cold repull
        // — the first-demand pull retrying, so demand-attributed.
        if (watch.query.roots.some(rootDirty)) markCold(watchId, "demand");
        continue;
      }
      const heldDeclared = new Set(
        [...held.values()].map(declaredEntityKey),
      );
      if (
        watch.query.roots.some((root) =>
          rootDirty(root) &&
          !heldDeclared.has(declaredEntityKey(root))
        )
      ) {
        // A wave names a root this watch does not track even as an absent
        // snapshot: only a traversal can (re)establish the closure.
        markCold(watchId, "wave");
        continue;
      }
      for (const snapshot of held.values()) {
        if (
          !revisions.some((revision) =>
            acceptedRevisionMatchesSnapshot(revision, snapshot)
          )
        ) continue;
        const key = snapshotKey(snapshot);
        const task = pointTasks.get(key);
        const actingContext = this.#watchActingContexts.get(watchId);
        if (task !== undefined) {
          task.watchIds.push(watchId);
          // Prefer the sponsor read for instances a context-free watch also
          // holds (a space-scoped doc resolves identically under any lane,
          // and a dead lane grant must not starve the shared read).
          if (actingContext === undefined) delete task.actingContext;
          continue;
        }
        pointTasks.set(key, {
          address: {
            id: snapshot.id,
            ...(snapshot.scope !== undefined ? { scope: snapshot.scope } : {}),
          },
          ...(actingContext !== undefined ? { actingContext } : {}),
          expected: snapshot,
          watchIds: [watchId],
        });
      }
    }

    // #appliedSeq is a global space watermark, not proof that every watch was
    // refreshed through that sequence. An unrelated point read can advance it
    // while this notice still names a changed entity held at an older revision.
    // Accepted-notice order already deduplicates work, so integrate every
    // matched instance even when the global watermark has reached this batch's
    // dataSeq.
    if (pointTasks.size === 0 && coldWatches.size === 0) {
      this.#acceptedOrder = acceptedOrder;
      this.#appliedSeq = Math.max(this.#appliedSeq, dataSeq);
      if (observations.length > 0) {
        this.#view?.applySync({
          type: "sync",
          fromSeq,
          toSeq: this.#appliedSeq,
          upserts: [],
          removes: [],
          observations,
        }, true);
        // WatchView delivery resumes the replica's async iterator in a queued
        // microtask. Cross that hand-off before reporting integration.
        await Promise.resolve();
      }
      return accepted;
    }

    // Steady-state integration (FA5): one exact engine read per matched held
    // instance, the whole batch evaluated at the wave's max durable data
    // sequence — every earlier revision is causally included — grouped by the
    // acting lane each owning watch registered under (FA6: the read surface
    // carries actingContext from day one). All reads complete before any map
    // mutation so a failed wave leaves the replica exactly as it was.
    //
    // FB13 wave resilience: per-group failures are ISOLATED. A rejected
    // group (e.g. a drained lane's `laneReadRejection`) must not discard the
    // whole spliced-out batch — surviving groups deliver, and the failed
    // group's notices are deferred for retry (never a fabricated "complete"
    // emission for the failed instances: their snapshots and watermarking
    // stay exactly as they were, mirroring how the cold path leaves
    // unrefreshed watches untouched).
    const failedTasks: PointReadTask[] = [];
    const failedColdWatchIds = new Set<string>();
    const steady: { task: PointReadTask; snapshot: EntitySnapshot }[] = [];
    if (pointTasks.size > 0) {
      const byContext = new Map<
        SchedulerExecutionContextKey | undefined,
        PointReadTask[]
      >();
      for (const task of pointTasks.values()) {
        const group = byContext.get(task.actingContext);
        if (group !== undefined) group.push(task);
        else byContext.set(task.actingContext, [task]);
      }
      for (const [actingContext, tasks] of byContext) {
        let result;
        try {
          result = await this.session.readDocs({
            docs: tasks.map((task) => task.address),
            branch: this.branch,
            atSeq: dataSeq,
          }, actingContext !== undefined ? { actingContext } : undefined);
        } catch (error) {
          // The whole group shares one acting context; a rejection fails all
          // of its tasks together. A cold fallback would re-send the SAME
          // dead context (the registered lane rides every re-query), so the
          // group defers instead — the lane-drain prune re-keys or retires
          // its watches and the deferred notices then integrate.
          failedTasks.push(...tasks);
          console.warn(
            "executor accepted-commit point-read group failed; deferring",
            actingContext,
            error,
          );
          continue;
        }
        for (const task of tasks) {
          // FA6 on the RESULT too: the returned instance must resolve to the
          // scope key the interest entry holds; anything else means the
          // resolution moved under us and only a traversal can re-key it.
          const snapshot = result.entities.find((entity) =>
            acceptedRevisionMatchesSnapshot(entity, task.expected)
          );
          if (snapshot === undefined) {
            // Resolution moved under us (FA6): the wave forces the re-key.
            for (const watchId of task.watchIds) markCold(watchId, "wave");
            continue;
          }
          steady.push({ task, snapshot });
        }
      }
    }

    // Topology gate and shrink policy (FA5): a steady wave leaves every held
    // doc's same-space link-target set unchanged for its owning watches. A
    // NEW target that is neither held by the watch nor referenced by the
    // previous version is closure GROWTH — only traversal can admit the new
    // doc. A disappeared target is closure SHRINK — removes cannot come from
    // point reads, and today the cold refresh's before/after diff is the only
    // remove carrier (F3 adds server-side doc-set membership deltas). Both
    // route the owning watch back through the cold graph path, so between
    // topology changes the interest set equals the last traversal's closure:
    // bounded, and unlinked docs stop matching (leave-the-closure fixture).
    const space = this.session.space;
    const heldDeclaredByWatch = new Map<string, Set<string>>();
    const heldDeclaredFor = (watchId: string): Set<string> => {
      const cached = heldDeclaredByWatch.get(watchId);
      if (cached !== undefined) return cached;
      const held = this.#watchEntities.get(watchId);
      const keys = new Set(
        held === undefined ? [] : [...held.values()].map(declaredEntityKey),
      );
      heldDeclaredByWatch.set(watchId, keys);
      return keys;
    };
    const applicable: { watchIds: string[]; snapshot: EntitySnapshot }[] = [];
    for (const { task, snapshot } of steady) {
      const oldTargets = collectLinkTargetKeys(
        task.expected.document,
        task.expected,
        space,
      );
      const newTargets = collectLinkTargetKeys(
        snapshot.document,
        snapshot,
        space,
      );
      let shrank = false;
      for (const target of oldTargets) {
        if (!newTargets.has(target)) {
          shrank = true;
          break;
        }
      }
      if (shrank) {
        // Shrink removes flow only from a traversal: wave-forced (FB12).
        for (const watchId of task.watchIds) markCold(watchId, "wave");
        continue;
      }
      const steadyWatchIds: string[] = [];
      for (const watchId of task.watchIds) {
        const held = heldDeclaredFor(watchId);
        let grew = false;
        for (const target of newTargets) {
          if (!oldTargets.has(target) && !held.has(target)) {
            grew = true;
            break;
          }
        }
        // Growth admits a NEW doc: demand-triggered (FA5's new-doc
        // closure-growth class), bounded to one query per cold event.
        if (grew) markCold(watchId, "demand");
        else steadyWatchIds.push(watchId);
      }
      if (steadyWatchIds.length > 0) {
        applicable.push({ watchIds: steadyWatchIds, snapshot });
      }
    }

    const applyPointUpdates = () => {
      for (const { watchIds, snapshot } of applicable) {
        const key = snapshotKey(snapshot);
        for (const watchId of watchIds) {
          const held = this.#watchEntities.get(watchId);
          if (held === undefined) continue;
          // Mixed-generation re-key: an entry matched through the declared
          // fallback may live under a scopeKey-less key; replace it.
          for (const [heldKey, heldSnapshot] of held) {
            if (
              heldKey !== key &&
              acceptedRevisionMatchesSnapshot(snapshot, heldSnapshot)
            ) {
              held.delete(heldKey);
            }
          }
          held.set(key, snapshot);
        }
      }
    };

    // FB13: a notice is integrated only when NONE of its revisions was left
    // behind by a failed point-read group or a failed cold refresh. Blocked
    // notices are deferred (re-queued), never lost — and never reported to
    // the integration observer until their retry actually integrates them.
    // Watermarks (#acceptedOrder/#appliedSeq) still advance: per the
    // watermark comment above they are not completeness proofs — the
    // deferred notices themselves carry the retry.
    const settleBlockedNotices = (): AcceptedCommitNotice[] => {
      if (failedTasks.length === 0 && failedColdWatchIds.size === 0) {
        return accepted;
      }
      const blockedByFailedWatch = (declared: string): boolean => {
        for (const watchId of failedColdWatchIds) {
          const watch = this.#watches.get(watchId);
          if (
            watch?.query.roots.some((root) =>
              declaredEntityKey(root) === declared
            )
          ) return true;
          if (heldDeclaredFor(watchId).has(declared)) return true;
        }
        return false;
      };
      const blocked = (notice: AcceptedCommitNotice): boolean =>
        notice.revisions.some((revision) =>
          failedTasks.some((task) =>
            acceptedRevisionMatchesSnapshot(revision, task.expected)
          ) || blockedByFailedWatch(declaredEntityKey(revision))
        );
      const integrated: AcceptedCommitNotice[] = [];
      const known = new Set(
        this.#deferredAcceptedCommits.map((notice) => notice.order),
      );
      for (const notice of accepted) {
        if (blocked(notice)) {
          if (!known.has(notice.order)) {
            this.#deferredAcceptedCommits.push(notice);
          }
        } else {
          integrated.push(notice);
        }
      }
      return integrated;
    };

    if (coldWatches.size > 0) {
      const before = this.allEntities();
      applyPointUpdates();
      // Cold path (unchanged semantics): closure growth, shrink, unresolved
      // roots, and resolution moves re-run the traversal at the same batch
      // sequence bound; its before/after diff carries the removes. FB13:
      // per-watch failures (a dead lane's re-sent acting context rejecting)
      // are isolated — the surviving watches refresh, the failed ones keep
      // their entities untouched and block their notices into the deferred
      // queue.
      await this.refreshWatches(
        [...coldWatches.keys()],
        dataSeq,
        coldWatches,
        (watchId, error) => {
          failedColdWatchIds.add(watchId);
          console.warn(
            "executor accepted-commit cold refresh failed; deferring",
            watchId,
            error,
          );
        },
      );
      this.#acceptedOrder = acceptedOrder;
      this.#appliedSeq = Math.max(this.#appliedSeq, dataSeq);
      const after = this.allEntities();
      const sync: SessionSync = {
        type: "sync",
        fromSeq,
        toSeq: this.#appliedSeq,
        upserts: [...after.values()].map(syncUpsert),
        removes: [...before.values()]
          .filter((snapshot) => !after.has(snapshotKey(snapshot)))
          .map((snapshot) => ({
            branch: snapshot.branch,
            id: snapshot.id,
            ...(snapshot.scope !== undefined ? { scope: snapshot.scope } : {}),
            // F2/FA6: instance-exact removes, mirroring the upsert identity.
            ...(snapshot.scopeKey !== undefined
              ? { scopeKey: snapshot.scopeKey }
              : {}),
          })),
        ...(observations.length > 0 ? { observations } : {}),
      };
      this.#view?.applySync(sync, true);
      // `applySync(..., true)` resolves the replica consumer's pending
      // iterator; its continuation applies the sync synchronously in the next
      // microtask.
      await Promise.resolve();
      return settleBlockedNotices();
    }

    // Pure steady-state wave: zero graph traversal; deliver exactly the
    // point-read snapshots. The old path re-upserted every held doc per wave;
    // the delta frame drops that redundant re-confirmation (and its
    // per-wave re-materialization in the Worker replica) — cold frames keep
    // the full-breadth shape. Observation-after-data same-turn ordering is
    // preserved in the same frame, as on the cold path.
    applyPointUpdates();
    this.#acceptedOrder = acceptedOrder;
    this.#appliedSeq = Math.max(this.#appliedSeq, dataSeq);
    const sync: SessionSync = {
      type: "sync",
      fromSeq,
      toSeq: this.#appliedSeq,
      upserts: applicable.map(({ snapshot }) => syncUpsert(snapshot)),
      removes: [],
      ...(observations.length > 0 ? { observations } : {}),
    };
    this.#view?.applySync(sync, true);
    // See the cold path: cross the WatchView iterator hand-off before
    // reporting integration.
    await Promise.resolve();
    return settleBlockedNotices();
  }

  /** HostReplicaSession owns a synthetic WatchView, so the underlying memory
   * client's execution-control stream must be copied into that view as an
   * ordered control-only sync. SpaceReplica intentionally consumes claims from
   * WatchView syncs, not the optional session callback surface. */
  private queueExecutionControl(event: ExecutionControlEvent): void {
    if (this.#closed) return;
    this.#pendingExecutionEvents.push(event);
    if (this.#executionDeliveryScheduled) return;
    this.#executionDeliveryScheduled = true;
    const delivery = this.#mutation.then(
      () => this.flushExecutionControl(),
      () => this.flushExecutionControl(),
    );
    this.#mutation = delivery.catch((error) => {
      if (!this.#closed) {
        console.warn("client execution-control delivery failed", error);
      }
    });
  }

  /** SpaceSession applies every event in one feed batch before advancing its
   * cursor. Its callback therefore cannot assign a cursor to one event. Cross
   * the callback stack, collect the whole burst, and advance this synthetic
   * WatchView feed exactly once. A settlement released later by the accepted
   * data barrier has no new upstream cursor, so it receives one synthetic
   * advance of its own. */
  private async flushExecutionControl(): Promise<void> {
    this.#executionDeliveryScheduled = false;
    if (this.#closed) {
      this.#pendingExecutionEvents.length = 0;
      return;
    }
    const events = this.#pendingExecutionEvents.splice(0);
    if (events.length === 0) return;
    const fromFeedSeq = this.#executionDeliverySeq;
    const toFeedSeq = Math.max(
      fromFeedSeq + 1,
      this.session.executionFeedSeq,
    );
    this.#executionDeliverySeq = toFeedSeq;
    await this.deliverExecutionBatches([{ fromFeedSeq, toFeedSeq, events }]);
  }

  private async deliverExecutionBatches(
    batches: readonly Readonly<{
      fromFeedSeq: number;
      toFeedSeq: number;
      events: ExecutionControlEvent[];
    }>[],
  ): Promise<void> {
    if (this.#closed || batches.length === 0) return;
    if (this.#view === null) {
      this.#pendingExecutionBatches.push(...batches);
      return;
    }
    for (const batch of batches) {
      this.#view.applySync({
        type: "sync",
        fromSeq: this.#appliedSeq,
        toSeq: this.#appliedSeq,
        upserts: [],
        removes: [],
        execution: {
          fromFeedSeq: batch.fromFeedSeq,
          toFeedSeq: batch.toFeedSeq,
          events: batch.events,
        },
      }, true);
      await Promise.resolve();
    }
  }

  closeExecutionControl(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeExecutionControl();
    this.#pendingAcceptedCommits.length = 0;
    this.#pendingExecutionEvents.length = 0;
    this.#pendingExecutionBatches.length = 0;
  }

  private async adoptionObservations(
    throughSeq: number,
    allowedObservationIds: ReadonlySet<number>,
  ): Promise<SchedulerActionSnapshotResult[]> {
    const snapshots: SchedulerActionSnapshotResult[] = [];
    const nextVersions = new Map<number, string>();
    const sinceCommitSeq = throughSeq <= this.#schedulerDeliverySeq
      ? Math.max(-1, throughSeq - 1)
      : this.#schedulerDeliverySeq;
    let cursor: SchedulerActionSnapshotQuery["cursor"];
    do {
      const page = await this.session.listSchedulerActionSnapshots({
        branch: this.branch,
        sinceCommitSeq,
        throughCommitSeq: throughSeq,
        limit: 1_000,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const snapshot of page.snapshots) {
        if (!allowedObservationIds.has(snapshot.observationId)) continue;
        const version = encodeMemoryBoundary(snapshot);
        if (
          this.#seenObservationVersions.get(snapshot.observationId) === version
        ) continue;
        nextVersions.set(snapshot.observationId, version);
        snapshots.push(snapshot);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    for (const [observationId, version] of nextVersions) {
      this.#seenObservationVersions.set(observationId, version);
    }
    this.#schedulerDeliverySeq = Math.max(
      this.#schedulerDeliverySeq,
      throughSeq,
    );
    return snapshots;
  }

  /**
   * Cold-path traversal for the named watches. `trigger` is the FA5/FB12
   * attribution each query carries — a single value (registration pulls are
   * all "demand") or a per-watch map (an accepted-commit wave classifies each
   * cold watch by cause). At most one graph query per watch per call: the
   * per-cold-event bound FA5 orders.
   *
   * `onError` (FB13): when provided, a per-watch query failure is reported
   * and the remaining watches still refresh — the accepted-commit wave path
   * isolates a dead lane's rejection instead of dropping the whole wave.
   * Without it (registration), the first failure propagates as before.
   */
  private async refreshWatches(
    watchIds: readonly string[],
    atSeq?: number,
    trigger?: GraphQueryTrigger | ReadonlyMap<string, GraphQueryTrigger>,
    onError?: (watchId: string, error: unknown) => void,
  ): Promise<void> {
    for (const watchId of watchIds) {
      const watch = this.#watches.get(watchId);
      if (watch === undefined) continue;
      const actingContext = this.#watchActingContexts.get(watchId);
      const watchTrigger = typeof trigger === "string"
        ? trigger
        : trigger?.get(watchId);
      let result;
      try {
        result = await this.queryGraph(
          {
            ...watch.query,
            ...(atSeq !== undefined ? { atSeq } : {}),
          },
          actingContext !== undefined || watchTrigger !== undefined
            ? {
              ...(actingContext !== undefined ? { actingContext } : {}),
              ...(watchTrigger !== undefined ? { trigger: watchTrigger } : {}),
            }
            : undefined,
        );
      } catch (error) {
        if (onError === undefined) throw error;
        onError(watchId, error);
        continue;
      }
      if (atSeq === undefined) {
        this.#appliedSeq = Math.max(this.#appliedSeq, result.serverSeq);
      }
      this.#watchEntities.set(
        watchId,
        new Map(result.entities.map((snapshot) => [
          snapshotKey(snapshot),
          snapshot,
        ])),
      );
    }
  }

  private allEntities(): Map<string, EntitySnapshot> {
    const entities = new Map<string, EntitySnapshot>();
    for (const snapshots of this.#watchEntities.values()) {
      for (const [key, snapshot] of snapshots) {
        const previous = entities.get(key);
        if (previous === undefined || previous.seq <= snapshot.seq) {
          entities.set(key, snapshot);
        }
      }
    }
    return entities;
  }

  private fullSync(fromSeq: number, toSeq: number): SessionSync {
    return {
      type: "sync",
      fromSeq,
      toSeq,
      upserts: [...this.allEntities().values()].map(syncUpsert),
      removes: [],
    };
  }
}

class HostSessionFactory implements SessionFactory {
  #session: HostReplicaSession | null = null;
  readonly supportsExecutionDemand: boolean;

  constructor(
    private readonly port: MessagePort,
    private readonly space: MemorySpace,
    private readonly branch: BranchName,
    private readonly protocolFlags?: Partial<WireMemoryProtocolFlags>,
    supportsExecutionDemand = false,
    private readonly onAcceptedCommitWillIntegrate?: (
      notice: AcceptedCommitNotice,
    ) => void,
    private readonly onAcceptedCommitIntegrated?: (
      notice: AcceptedCommitNotice,
    ) => void,
    private readonly onForeignWake?: (notice: ForeignWakeNotice) => void,
  ) {
    this.supportsExecutionDemand = supportsExecutionDemand;
  }

  acceptedCommitsSettled(): Promise<number> {
    return this.#session?.acceptedCommitsSettled() ?? Promise.resolve(0);
  }

  async create(
    space: MemorySpace,
    _signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    if (space !== this.space) {
      throw new Error(`executor provider is bound to ${this.space}`);
    }
    const transport = new MessagePortTransport(this.port);
    const client = await MemoryClient.connect({
      transport,
      ...(this.protocolFlags ? { protocolFlags: this.protocolFlags } : {}),
    });
    const lifecycle: { replica?: HostReplicaSession } = {};
    // This transferred channel is a lease-bound one-shot transport, not a
    // reconnectable network endpoint. A host close is terminal: close the
    // client so pending requests reject without starting the generic memory
    // client's reconnect loop against an already-disposed MessagePort.
    transport.setCloseReceiver(() => {
      lifecycle.replica?.closeExecutionControl();
      void client.close().catch(() => undefined);
    });
    const session = await client.mount(space, mountOptions);
    const replica = new HostReplicaSession(
      session,
      transport,
      this.branch,
      this.supportsExecutionDemand,
      this.onAcceptedCommitWillIntegrate,
      this.onAcceptedCommitIntegrated,
      this.onForeignWake,
    );
    lifecycle.replica = replica;
    this.#session = replica;
    const replicaClient: ReplicaClient = {
      get serverFlags() {
        return client.serverFlags;
      },
      close: async () => {
        replica.closeExecutionControl();
        await client.close();
      },
    };
    return {
      client: replicaClient,
      session: replica,
    };
  }
}

const opaquePrincipal = (principal: MemorySpace): Signer => {
  const unavailable = () => ({
    error: new Error("executor provider principal has no Worker signing key"),
  });
  return {
    did: () => principal,
    sign: unavailable,
    verifier: {
      did: () => principal,
      verify: unavailable,
    },
  } as Signer;
};

export interface HostStorageManagerOptions {
  port: MessagePort;
  principal: MemorySpace;
  space: MemorySpace;
  branch?: BranchName;
  id?: string;
  settings?: Options["settings"];
  protocolFlags?: Partial<WireMemoryProtocolFlags>;
  /** Client-realm host channels may publish connection-owned execution
   *  demand. Executor Workers leave this false. */
  supportsExecutionDemand?: boolean;
  /** Keep executor-derived writes inside the Worker replica for shadow graph
   * discovery. No transaction or scheduler operation reaches the host. */
  shadowWrites?: boolean;
  /** Worker-local whole-action routing. The host still validates every
   * asserted upstream transaction against its live lease and claim. */
  actionTransactionRouter?: ActionTransactionRouter;
  /** C1.5b per-lane acting context: resolve a source action's owning
   * execution lane (the Worker consults the action's live claim), so its
   * commits assert exactly one lane and its documents key by that lane's
   * effective scope keys. */
  executionLaneForAction?: (
    action: object,
  ) => SchedulerExecutionContextKey | undefined;
  /** Runs synchronously after notice ordering checks but before scheduler or
   * document integration, for causal attribution of the resulting rerun. */
  onAcceptedCommitWillIntegrate?: (notice: AcceptedCommitNotice) => void;
  /** Runs synchronously after an accepted host commit has been point-refreshed
   * and applied to the Worker replica. */
  onAcceptedCommitIntegrated?: (notice: AcceptedCommitNotice) => void;
  /** C3.3a (C3A11): a foreign wake reached this Worker — home actions
   * with mirrored foreign reads went stale in another space's seq domain.
   * Ordered behind in-flight accepted-commit integrations; carries no
   * home commit. See {@link ForeignWakeNotice} for the pre-C3.4 fail-
   * closed posture the consumer must keep. */
  onForeignWake?: (notice: ForeignWakeNotice) => void;
}

/** StorageManager construction available inside the executor Worker. */
export class HostStorageManager extends StorageManager {
  readonly #hostSessionFactory: HostSessionFactory;

  private constructor(options: Options, factory: HostSessionFactory) {
    super(options, factory);
    this.#hostSessionFactory = factory;
  }

  static connect(options: HostStorageManagerOptions): HostStorageManager {
    const as = opaquePrincipal(options.principal);
    const factory = new HostSessionFactory(
      options.port,
      options.space,
      options.branch ?? "",
      options.protocolFlags,
      options.supportsExecutionDemand === true,
      options.onAcceptedCommitWillIntegrate,
      options.onAcceptedCommitIntegrated,
      options.onForeignWake,
    );
    return new HostStorageManager(
      {
        as,
        id: options.id,
        settings: options.settings,
        shadowWrites: options.shadowWrites,
        actionTransactionRouter: options.actionTransactionRouter,
        executionLaneForAction: options.executionLaneForAction,
        // The host channel is already pinned to the memory Server.
        memoryHost: new URL("memory://executor-provider"),
      },
      factory,
    );
  }

  /** Drain the host-pushed accepted-commit queue and return the last data seq
   * applied to this Worker replica. */
  acceptedCommitsSettled(): Promise<number> {
    return this.#hostSessionFactory.acceptedCommitsSettled();
  }
}
