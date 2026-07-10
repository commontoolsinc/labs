import type {
  IMemorySpaceAddress,
  TransactionReactivityLog,
} from "../storage/interface.ts";
import { isCellScope } from "../scope.ts";

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
  currentKnownWrites: IMemorySpaceAddress[];
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
  currentKnownWrites: readonly IMemorySpaceAddress[];
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
    // Persist the live write surface (slim only `declaredWrites`): rehydration
    // restores annotation-less actions' surfaces from this field — the live
    // ReactivityLog that produced it is gone after a process restart.
    currentKnownWrites: cloneAddresses(options.currentKnownWrites),
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
    isNonNegativeInteger(candidate.processGeneration) &&
    typeof candidate.actionId === "string" &&
    isSchedulerActionKind(candidate.actionKind) &&
    typeof candidate.implementationFingerprint === "string" &&
    typeof candidate.runtimeFingerprint === "string" &&
    isNonNegativeInteger(candidate.observedAtSeq) &&
    (candidate.observedAtLocalSeq === undefined ||
      isNonNegativeInteger(candidate.observedAtLocalSeq)) &&
    isSchedulerObservationTransactionKind(candidate.transactionKind) &&
    isAddressArray(candidate.reads) &&
    isAddressArray(candidate.shallowReads) &&
    isAddressArray(candidate.actualChangedWrites) &&
    // The live write surface is required in both versions. Without it an
    // annotation-less computation can be restored clean with no writer edge,
    // permanently disconnecting its downstream readers.
    isAddressArray(candidate.currentKnownWrites) &&
    (candidate.declaredWrites === undefined
      ? version === 2
      : isAddressArray(candidate.declaredWrites)) &&
    isAddressArray(candidate.materializerWriteEnvelopes) &&
    (candidate.ignoredSchedulingWrites === undefined ||
      isAddressArray(candidate.ignoredSchedulingWrites)) &&
    (candidate.actionOptions === undefined ||
      isSchedulerActionOptions(candidate.actionOptions)) &&
    isSchedulerObservationStatus(candidate.status) &&
    (candidate.errorFingerprint === undefined ||
      typeof candidate.errorFingerprint === "string");
}

function isAddressArray(value: unknown): value is IMemorySpaceAddress[] {
  return Array.isArray(value) && value.every(isMemorySpaceAddress);
}

function isMemorySpaceAddress(value: unknown): value is IMemorySpaceAddress {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<IMemorySpaceAddress>;
  return typeof candidate.space === "string" &&
    typeof candidate.id === "string" &&
    (candidate.scope === undefined || isCellScope(candidate.scope)) &&
    (candidate.type === undefined || typeof candidate.type === "string") &&
    Array.isArray(candidate.path) &&
    candidate.path.every((segment) => typeof segment === "string");
}

function isSchedulerActionOptions(
  value: unknown,
): value is SchedulerActionOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SchedulerActionOptions>;
  return (candidate.debounceMs === undefined ||
    isNonNegativeFiniteNumber(candidate.debounceMs)) &&
    (candidate.noDebounce === undefined ||
      typeof candidate.noDebounce === "boolean") &&
    (candidate.throttleMs === undefined ||
      isNonNegativeFiniteNumber(candidate.throttleMs));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
