/**
 * Bounds speculative transactions to their local replica. Unavailable data
 * poisons the whole attempt, including when authored code catches the signal.
 */

import { PathKeyMap } from "@commonfabric/utils/path-key-map";

import type { IMemorySpaceAddress, IStorageTransaction } from "./interface.ts";
import { transactionLayers } from "./reactivity-log.ts";

/** Signals that a computation cannot finish from its local input basis. */
export class LocalReadUnavailable extends Error {
  #address: IMemorySpaceAddress;

  /** Constructs an instance naming the unavailable read. */
  constructor(address: IMemorySpaceAddress) {
    super(`Local input is unavailable: ${address.id}`);
    this.name = "LocalReadUnavailable";
    this.#address = { ...address, path: [...address.path] };
  }

  /** Address retained as a wake dependency even if the signal was caught. */
  get address(): IMemorySpaceAddress {
    return this.#address;
  }
}

/** Local eligibility in addition to replica coverage, such as producer currency. */
type LocalReadPolicy = {
  permits?: () => (address: IMemorySpaceAddress) => boolean;
  /** The checker the transaction's reads share, made at its first read. */
  readPermits?: (address: IMemorySpaceAddress) => boolean;
  failure?: LocalReadUnavailable;
  basis: PathKeyMap<{ address: IMemorySpaceAddress; covered: () => boolean }>;
  /** How many value reads the basis has recorded, repeats included. */
  reads: number;
  conditions: { address: IMemorySpaceAddress; current: () => boolean }[];
  wakes: PathKeyMap<IMemorySpaceAddress>;
  /**
   * The validation a commit passed, made just before committing, and how
   * much of the basis it saw.
   */
  validatedForCommit?: { stretch: object; reads: number; conditions: number };
};

const policies = new WeakMap<object, LocalReadPolicy>();

/**
 * The synchronous stretch a commit's validations share. It ends at the next
 * microtask checkpoint, or sooner when a transaction applies its writes to a
 * replica or a replica applies a frame.
 */
let validationStretch: object | undefined;

/** The open stretch, opening one when none is. */
function currentValidationStretch(): object {
  if (validationStretch === undefined) {
    const stretch = {};
    validationStretch = stretch;
    queueMicrotask(() => {
      if (validationStretch === stretch) validationStretch = undefined;
    });
  }
  return validationStretch;
}

/**
 * Ends the open validation stretch, so that every validation after it checks
 * replica and local scheduler state again. A transaction calls this as it
 * applies its writes to a replica, and a replica once it has applied a
 * frame, since either can change what the validations before them proved.
 */
export function endLocalReadValidationStretch(): void {
  validationStretch = undefined;
}

/**
 * Restricts a transaction before its first read; restrictions cannot be cleared.
 * `permits` creates a checker. The transaction's reads share one, and each
 * validation pass makes its own, so what a read let through is checked again
 * before the transaction can seal. The passes a commit makes itself stand on
 * the one `validateLocalReadBasisForCommit` made just before it.
 */
export function restrictToLocalReads(
  tx: IStorageTransaction,
  permits?: () => (address: IMemorySpaceAddress) => boolean,
): void {
  if (policyFor(tx) !== undefined) {
    throw new Error("Local read policy is already installed");
  }
  if ([...(tx.getReadActivities?.() ?? [])].length > 0 || tx.hasWrites?.()) {
    throw new Error("Local read policy must precede transaction activity");
  }
  const policy: LocalReadPolicy = {
    permits,
    basis: new PathKeyMap(),
    reads: 0,
    conditions: [],
    wakes: new PathKeyMap(),
  };
  for (const layer of transactionLayers(tx)) policies.set(layer, policy);
}

/** Whether implicit Cell reads must avoid acquiring subscriptions. */
export function usesLocalReads(tx: object | undefined): boolean {
  return tx !== undefined && policyFor(tx) !== undefined;
}

/** Returns the latched failure, including a signal caught by authored code. */
export function localReadFailure(
  tx: object,
): LocalReadUnavailable | undefined {
  return policyFor(tx)?.failure;
}

/** Checks a value-consuming read after its wake dependency has been recorded. */
export function assertLocalReadAvailable(
  tx: IStorageTransaction,
  address: IMemorySpaceAddress,
  covered: () => boolean,
): void {
  const policy = policyFor(tx);
  if (policy === undefined) return;
  policy.basis.set([
    address.space,
    address.scope ?? "space",
    address.id,
    ...address.path,
  ], { address, covered });
  policy.reads++;
  if (covered()) {
    policy.readPermits ??= policy.permits?.();
    if (policy.readPermits?.(address) !== false) return;
  }
  const failure = new LocalReadUnavailable(address);
  policy.failure ??= failure;
  throw failure;
}

/** Releases completion-only checks while retaining the local-only mark and failure. */
export function releaseLocalReadBasis(tx: object): void {
  const policy = policyFor(tx);
  if (policy === undefined) return;
  policy.basis.clear();
  policy.wakes.clear();
  policy.conditions.length = 0;
  policy.permits = undefined;
  policy.readPermits = undefined;
  policy.validatedForCommit = undefined;
}

/** Whether the inputs of a disposed attempt have become eligible for a new run. */
export function localReadsReady(tx: object): boolean {
  const policy = policyFor(tx);
  if (policy === undefined) return true;
  if (policy.conditions.some(({ current }) => !current())) return false;
  const permits = policy.permits?.();
  for (const [, { address, covered }] of policy.basis.entries()) {
    if (!covered() || permits?.(address) === false) return false;
  }
  return true;
}

/**
 * Rechecks residency and producer currency before a transaction can seal. A
 * transaction `validateLocalReadBasisForCommit` passed in the open stretch,
 * having read and required nothing since, stands on that pass.
 */
export function validateLocalReadBasis(
  tx: object,
): LocalReadUnavailable | undefined {
  const policy = policyFor(tx);
  if (policy === undefined || policy.failure !== undefined) {
    return policy?.failure;
  }
  const validated = policy.validatedForCommit;
  if (
    validated !== undefined && validated.stretch === validationStretch &&
    validated.reads === policy.reads &&
    validated.conditions === policy.conditions.length
  ) return undefined;
  return validatePolicy(policy);
}

/**
 * Validates a transaction about to commit, as `validateLocalReadBasis` does,
 * for a caller that commits it next in the same synchronous stretch. The
 * validations the commit makes before it hands its writes over then stand on
 * this one, unless the transaction reads or requires more first: nothing they
 * check can change in between.
 */
export function validateLocalReadBasisForCommit(
  tx: object,
): LocalReadUnavailable | undefined {
  const policy = policyFor(tx);
  if (policy === undefined || policy.failure !== undefined) {
    return policy?.failure;
  }
  const failure = validatePolicy(policy);
  if (failure === undefined) {
    policy.validatedForCommit = {
      stretch: currentValidationStretch(),
      reads: policy.reads,
      conditions: policy.conditions.length,
    };
  }
  return failure;
}

/** One full validation pass over `policy`, latching the first failure. */
function validatePolicy(
  policy: LocalReadPolicy,
): LocalReadUnavailable | undefined {
  for (const { address, current } of policy.conditions) {
    if (current()) continue;
    policy.failure = new LocalReadUnavailable(address);
    return policy.failure;
  }
  const permits = policy.permits?.();
  for (const [, { address, covered }] of policy.basis.entries()) {
    if (covered() && permits?.(address) !== false) continue;
    policy.failure = new LocalReadUnavailable(address);
    break;
  }
  return policy.failure;
}

/** Records an eligibility dependency without consuming or requesting its value. */
export function recordLocalReadWake(
  tx: object,
  address: IMemorySpaceAddress,
): void {
  policyFor(tx)?.wakes.set([
    address.space,
    address.scope ?? "space",
    address.id,
    ...address.path,
  ], address);
}

/** Extra wake inputs checked through authoritative fingerprints. */
export function localReadWakeDependencies(tx: object): IMemorySpaceAddress[] {
  return [...(policyFor(tx)?.wakes.entries() ?? [])].map(([, address]) =>
    address
  );
}

/** Fences an attempt even when its authored computation consumes no values. */
export function requireLocalReadCondition(
  tx: IStorageTransaction,
  address: IMemorySpaceAddress,
  current: () => boolean,
): void {
  const policy = policyFor(tx);
  if (policy === undefined) throw new Error("Local read policy is required");
  policy.conditions.push({ address, current });
  if (current()) return;
  policy.failure ??= new LocalReadUnavailable(address);
  throw policy.failure;
}

/** Helper for local read restrictions, which follows wrappers created later. */
function policyFor(tx: object): LocalReadPolicy | undefined {
  for (const layer of transactionLayers(tx)) {
    const policy = policies.get(layer);
    if (policy !== undefined) return policy;
  }
  return undefined;
}
