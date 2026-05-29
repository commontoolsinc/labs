import type {
  IMemorySpaceAddress,
  TransactionReactivityLog,
  TransactionReadWatermark,
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

export type SchedulerObservedRead = TransactionReadWatermark;

export interface SchedulerActionObservation {
  version: 1;
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
  readWatermarks?: SchedulerObservedRead[];
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
    ...(options.transactionLog.readWatermarks &&
        options.transactionLog.readWatermarks.length > 0
      ? {
        readWatermarks: cloneObservedReads(
          options.transactionLog.readWatermarks,
        ),
      }
      : {}),
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

export function isSchedulerActionObservation(
  value: unknown,
): value is SchedulerActionObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SchedulerActionObservation>;
  return candidate.version === 1 &&
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
    (candidate.readWatermarks === undefined ||
      Array.isArray(candidate.readWatermarks)) &&
    Array.isArray(candidate.actualChangedWrites) &&
    Array.isArray(candidate.currentKnownWrites) &&
    Array.isArray(candidate.declaredWrites) &&
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

function cloneObservedReads(
  reads: readonly SchedulerObservedRead[],
): SchedulerObservedRead[] {
  return reads.map((read) => ({
    ...read,
    path: [...read.path],
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
  return value === "dependency-collection" ||
    value === "action-run" ||
    value === "event-preflight";
}

function isSchedulerObservationStatus(
  value: unknown,
): value is SchedulerActionObservation["status"] {
  return value === "success" || value === "failed";
}
