import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
import { readsOverlapWrites } from "./scheduling-writes.ts";
import type { Action, ReactivityLog, SpaceScopeAndURI } from "./types.ts";

export interface MaterializerIndexState {
  readonly materializersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  getMaterializerWriteEnvelopes(
    action: Action,
  ): readonly IMemorySpaceAddress[] | undefined;
  isMaterializer(action: Action): boolean;
}

export class SchedulerMaterializers implements MaterializerIndexState {
  readonly materializers = new Set<Action>();
  readonly materializersByEntity = new Map<SpaceScopeAndURI, Set<Action>>();
  private readonly writeEnvelopes = new WeakMap<
    Action,
    IMemorySpaceAddress[]
  >();
  private readonly actionEntities = new WeakMap<
    Action,
    Set<SpaceScopeAndURI>
  >();

  constructor(
    readonly effects: ReadonlySet<Action>,
  ) {}

  register(
    action: Action,
    envelopes: readonly NormalizedFullLink[] | undefined,
  ): void {
    this.clearAction(action);
    if (!envelopes || envelopes.length === 0) return;

    this.registerAddresses(action, envelopes.map(toMemorySpaceAddress));
  }

  registerAddresses(
    action: Action,
    envelopes: readonly IMemorySpaceAddress[] | undefined,
  ): void {
    this.clearAction(action);
    if (!envelopes || envelopes.length === 0) return;

    const writes = sortAndCompactPaths([...envelopes]);
    if (writes.length === 0) return;

    this.materializers.add(action);
    this.writeEnvelopes.set(action, writes);

    const entities = new Set<SpaceScopeAndURI>();
    for (const write of writes) {
      const entity = entityKey(write);
      entities.add(entity);
      let materializers = this.materializersByEntity.get(entity);
      if (!materializers) {
        materializers = new Set<Action>();
        this.materializersByEntity.set(entity, materializers);
      }
      materializers.add(action);
    }
    this.actionEntities.set(action, entities);
  }

  clearAction(action: Action): void {
    this.materializers.delete(action);
    this.writeEnvelopes.delete(action);
    const entities = this.actionEntities.get(action);
    if (!entities) return;

    for (const entity of entities) {
      const materializers = this.materializersByEntity.get(entity);
      materializers?.delete(action);
      if (materializers && materializers.size === 0) {
        this.materializersByEntity.delete(entity);
      }
    }
    this.actionEntities.delete(action);
  }

  isMaterializer(action: Action): boolean {
    return this.materializers.has(action);
  }

  getMaterializerWriteEnvelopes(
    action: Action,
  ): readonly IMemorySpaceAddress[] | undefined {
    return this.writeEnvelopes.get(action);
  }
}

export function collectMaterializerWritersForLog(
  state: MaterializerIndexState,
  log: ReactivityLog,
  options: { exclude?: Action } = {},
): Set<Action> {
  const writers = new Set<Action>();
  const reads = [...log.reads, ...log.shallowReads];
  for (const read of reads) {
    const candidates = state.materializersByEntity.get(entityKey(read));
    if (!candidates) continue;

    for (const candidate of candidates) {
      if (candidate === options.exclude) continue;
      if (state.effects.has(candidate)) continue;
      const envelopes = state.getMaterializerWriteEnvelopes(candidate) ?? [];
      if (readsOverlapWrites(log.reads, log.shallowReads, envelopes)) {
        writers.add(candidate);
      }
    }
  }
  return writers;
}
