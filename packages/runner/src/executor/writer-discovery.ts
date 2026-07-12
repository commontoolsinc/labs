import type { Cell } from "../cell.ts";
import { parseLink, toMemorySpaceAddress } from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import type { SchedulerWriterCandidate } from "../scheduler/writer-lookup.ts";
import type { MemorySpace } from "../storage/interface.ts";

export interface ExecutorWriterCandidateIdentity {
  readonly branch: string;
  readonly ownerSpace?: string;
  readonly pieceId: string;
  readonly processGeneration: number;
  readonly actionId: string;
  readonly actionKind: "computation" | "effect" | "event-handler";
  readonly implementationFingerprint: string;
  readonly runtimeFingerprint: string;
  readonly source: "live" | "durable" | "live+durable";
}

export interface ExecutorWriterDiscovery {
  readonly pieceId: string;
  readonly indexMiss: boolean;
  readonly writers: readonly ExecutorWriterCandidateIdentity[];
}

const writerIdentity = (
  candidate: SchedulerWriterCandidate,
): ExecutorWriterCandidateIdentity => ({
  branch: candidate.branch,
  ...(candidate.ownerSpace !== undefined
    ? { ownerSpace: candidate.ownerSpace }
    : {}),
  pieceId: candidate.pieceId,
  processGeneration: candidate.processGeneration,
  actionId: candidate.actionId,
  actionKind: candidate.actionKind,
  implementationFingerprint: candidate.implementationFingerprint,
  runtimeFingerprint: candidate.runtimeFingerprint,
  source: candidate.source,
});

/**
 * Query durable writer identity before instantiation, then query the merged
 * live+durable view after the demanded piece has been instantiated. An index
 * miss therefore fails open by loading the piece root, while an existing
 * redirected target remains attributed to its current scheduler writer.
 */
export async function prepareExecutorDemandPiece(options: {
  runtime: Runtime;
  branch: string;
  pieceId: string;
  target: Cell<unknown>;
  instantiate: () => Promise<unknown>;
}): Promise<ExecutorWriterDiscovery> {
  const targets = (): ReturnType<typeof toMemorySpaceAddress>[] => {
    const addresses: ReturnType<typeof toMemorySpaceAddress>[] = [];
    const seen = new Set<string>();
    let cell = options.target;
    for (let depth = 0; depth < 8; depth++) {
      const link = cell.getAsNormalizedFullLink();
      const key = JSON.stringify([link.space, link.id, link.scope, link.path]);
      if (seen.has(key)) break;
      seen.add(key);
      addresses.push(toMemorySpaceAddress(link));
      const redirect = parseLink(cell.getRaw(), cell);
      if (redirect === undefined) break;
      cell = options.runtime.getCellFromLink(redirect);
    }
    return addresses;
  };
  const lookup = (): Promise<SchedulerWriterCandidate[]> =>
    options.runtime.scheduler.writersForTargets(
      options.branch,
      options.target.space as MemorySpace,
      targets(),
    ).catch(() => []);

  const before = await lookup();
  await options.instantiate();
  const after = await lookup();
  return {
    pieceId: options.pieceId,
    indexMiss: before.length === 0,
    writers: (after.length > 0 ? after : before).map(writerIdentity),
  };
}
