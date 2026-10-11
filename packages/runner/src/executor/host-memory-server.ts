// The memory server as a serving host reaches it. The host, the space
// server, the outbox and the view-plan publisher name this type rather than
// the server class, so that the host can run where the server's object is
// not at hand (a worker of the same process) behind an implementation that
// carries each member across. The in-process server satisfies it as it is.

import type { Server } from "@commonfabric/memory/v2/server";

/**
 * The members of the memory server a serving host calls, as the server
 * declares them, less the ones below.
 */
type ServerMembers = Pick<
  Server,
  | "setServerExecutionObserver"
  | "hasLiveSessionsForSpace"
  | "hasLiveSessionFor"
  | "sessionReadCeiling"
  | "idle"
  | "flushSessions"
  | "noteExecutorCommit"
  | "noteLeaseReacquired"
  | "checkServedAclChange"
  | "commitServedAclChange"
  | "commitDelegatedAppend"
  | "engineForSpace"
  | "foreignWriteAuthorityFor"
  | "resolveSpaceOwner"
  | "setViewSelection"
>;

/**
 * The memory server, as a serving host reaches it: the in-process server
 * itself, or an implementation that carries each member to one across a
 * worker boundary. Two members the server answers synchronously may answer
 * with a promise here, because their answers are built from state only the
 * server's thread holds; their callers await them. The members that answer
 * synchronously everywhere are the ones an implementation elsewhere answers
 * from a mirror the server keeps current.
 */
export type HostMemoryServer = ServerMembers & {
  /** @see Server.demandForSpace */
  demandForSpace(
    ...args: Parameters<Server["demandForSpace"]>
  ):
    | ReturnType<Server["demandForSpace"]>
    | Promise<ReturnType<Server["demandForSpace"]>>;
  /** @see Server.viewInterestsForSpace */
  viewInterestsForSpace(
    ...args: Parameters<Server["viewInterestsForSpace"]>
  ):
    | ReturnType<Server["viewInterestsForSpace"]>
    | Promise<ReturnType<Server["viewInterestsForSpace"]>>;
  /**
   * Attaches a wave batch's sqlite cell databases for the in-process wave
   * commit sink. Absent where the sink runs elsewhere, which is where the
   * host is given a sink of its own instead.
   */
  attachWaveCommitSqliteDbs?: Server["attachWaveCommitSqliteDbs"];
};

/** What the serving runtime's loopback storage plane needs of the server. */
export type LoopbackMemoryServer = Pick<Server, "connect">;
