import type {
  IMemorySpaceAddress,
  TransactionReactivityLog,
} from "../storage/interface.ts";

export type SchedulerActionKind =
  | "computation"
  | "effect"
  | "event-handler";

export type SchedulerObservationTransactionKind =
  | "action-run"
  | "event-preflight";

export interface SchedulerActionOptions {
  debounceMs?: number;
  noDebounce?: boolean;
  throttleMs?: number;
}

export interface SchedulerActionObservation {
  version: 1 | 2;
  ownerSpace?: string;
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
  currentKnownWrites?: IMemorySpaceAddress[];
  declaredWrites?: IMemorySpaceAddress[];
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
  ownerSpace?: string;
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
    version: 2,
    ...(options.ownerSpace !== undefined
      ? { ownerSpace: options.ownerSpace }
      : {}),
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

export function isSchedulerActionObservation(
  value: unknown,
): value is SchedulerActionObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SchedulerActionObservation>;
  const version = candidate.version;
  return (version === 1 || version === 2) &&
    (candidate.ownerSpace === undefined ||
      typeof candidate.ownerSpace === "string") &&
    typeof candidate.branch === "string" &&
    typeof candidate.pieceId === "string" &&
    typeof candidate.processGeneration === "number" &&
    typeof candidate.actionId === "string" &&
    isSchedulerActionKind(candidate.actionKind) &&
    typeof candidate.implementationFingerprint === "string" &&
    typeof candidate.runtimeFingerprint === "string" &&
    typeof candidate.observedAtSeq === "number" &&
    isSchedulerObservationTransactionKind(candidate.transactionKind) &&
    Array.isArray(candidate.reads) &&
    Array.isArray(candidate.shallowReads) &&
    Array.isArray(candidate.actualChangedWrites) &&
    (version === 2 || Array.isArray(candidate.currentKnownWrites)) &&
    (version === 2 || Array.isArray(candidate.declaredWrites)) &&
    Array.isArray(candidate.materializerWriteEnvelopes) &&
    isSchedulerObservationStatus(candidate.status);
}

function cloneAddresses(
  addresses: readonly IMemorySpaceAddress[],
): IMemorySpaceAddress[] {
  return addresses.map((address) => ({
    ...address,
    path: [...address.path],
  }));
}

function isSchedulerActionKind(value: unknown): value is SchedulerActionKind {
  return value === "computation" ||
    value === "effect" ||
    value === "event-handler";
}

function isSchedulerObservationTransactionKind(
  value: unknown,
): value is SchedulerObservationTransactionKind {
  return value === "action-run" ||
    value === "event-preflight";
}

function isSchedulerObservationStatus(
  value: unknown,
): value is SchedulerActionObservation["status"] {
  return value === "success" || value === "failed";
}
