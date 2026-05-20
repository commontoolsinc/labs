import type {
  IMemorySpaceAddress,
  TransactionReactivityLog,
} from "../storage/interface.ts";

export type SchedulerActionKind =
  | "computation"
  | "effect"
  | "event-handler";

export type SchedulerObservationTransactionKind =
  | "dependency-collection"
  | "action-run"
  | "event-preflight";

export interface SchedulerActionOptions {
  debounceMs?: number;
  noDebounce?: boolean;
  throttleMs?: number;
}

export interface SchedulerActionObservation {
  version: 1;
  branch: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  actionKind: SchedulerActionKind;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  observedAtSeq: number;
  observedAtLocalSeq?: number;
  transactionKind: SchedulerObservationTransactionKind;
  reads: IMemorySpaceAddress[];
  shallowReads: IMemorySpaceAddress[];
  actualChangedWrites: IMemorySpaceAddress[];
  currentKnownWrites: IMemorySpaceAddress[];
  declaredWrites: IMemorySpaceAddress[];
  materializerWriteEnvelopes: IMemorySpaceAddress[];
  ignoredSchedulingWrites?: IMemorySpaceAddress[];
  actionOptions?: SchedulerActionOptions;
  status: "success" | "failed";
  errorFingerprint?: string;
}

export interface PersistedSchedulerObservationSnapshot {
  observation: SchedulerActionObservation;
  directDirtySeq?: number;
  staleSeq?: number;
  unknownReason?: string;
}

export interface BuildSchedulerActionObservationOptions {
  branch: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  actionKind: SchedulerActionKind;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  observedAtSeq: number;
  observedAtLocalSeq?: number;
  transactionKind: SchedulerObservationTransactionKind;
  transactionLog: TransactionReactivityLog;
  currentKnownWrites?: readonly IMemorySpaceAddress[];
  declaredWrites?: readonly IMemorySpaceAddress[];
  materializerWriteEnvelopes?: readonly IMemorySpaceAddress[];
  ignoredSchedulingWrites?: readonly IMemorySpaceAddress[];
  actionOptions?: SchedulerActionOptions;
  status?: "success" | "failed";
  errorFingerprint?: string;
}

export function buildSchedulerActionObservation(
  options: BuildSchedulerActionObservationOptions,
): SchedulerActionObservation {
  return {
    version: 1,
    branch: options.branch,
    pieceId: options.pieceId,
    processGeneration: options.processGeneration,
    actionId: options.actionId,
    actionKind: options.actionKind,
    implementationFingerprint: options.implementationFingerprint,
    runtimeFingerprint: options.runtimeFingerprint,
    observedAtSeq: options.observedAtSeq,
    ...(options.observedAtLocalSeq !== undefined
      ? { observedAtLocalSeq: options.observedAtLocalSeq }
      : {}),
    transactionKind: options.transactionKind,
    reads: cloneAddresses(options.transactionLog.reads),
    shallowReads: cloneAddresses(options.transactionLog.shallowReads),
    actualChangedWrites: cloneAddresses(options.transactionLog.writes),
    currentKnownWrites: cloneAddresses(options.currentKnownWrites ?? []),
    declaredWrites: cloneAddresses(options.declaredWrites ?? []),
    materializerWriteEnvelopes: cloneAddresses(
      options.materializerWriteEnvelopes ?? [],
    ),
    ...(options.ignoredSchedulingWrites &&
        options.ignoredSchedulingWrites.length > 0
      ? {
        ignoredSchedulingWrites: cloneAddresses(
          options.ignoredSchedulingWrites,
        ),
      }
      : {}),
    ...(options.actionOptions ? { actionOptions: options.actionOptions } : {}),
    status: options.status ?? "success",
    ...(options.errorFingerprint
      ? { errorFingerprint: options.errorFingerprint }
      : {}),
  };
}

function cloneAddresses(
  addresses: readonly IMemorySpaceAddress[],
): IMemorySpaceAddress[] {
  return addresses.map((address) => ({
    ...address,
    path: [...address.path],
  }));
}
